// Main-process side of the Releases board. Owns its own state file so removing
// the feature is deleting the releases-* files plus two hook lines in main.js.
// Renderer contract: receives releasesOpen / releasesClose / releasesRefresh /
// releasesSetSource, sends { type: 'releases', state }.

const fs = require('fs');
const path = require('path');
const { releaseFixBrief } = require('./release-playbook');
const { runRelease, prHealth, rowStatus } = require('./release-run');
const createHistory = require('./release-history');
const { signoff, reviewMark, hasSigned, openerMark, OPENER_RE } = require('./signoff-core');
const APPROVERS_TEAM = 'release-approvers'; // GitHub team in the config repo's org: who may release + sign prod
const { execFile } = require('child_process');
const os = require('os');
const { releaseTargets, releasePlan } = require('./releases-core');
const { newDeployFailures, parseSource, validateConfig, requestsFor, buildGrid, commitTitle, firstParentChain, runState, liveSha, SAFE_REF_RE, DEFAULT_SOURCE } = require('./releases-core');

const REFRESH_MS = 5 * 60 * 1000;
const DEPLOYING_MS = 10 * 1000;       // re-read deploy runs this often while one is in flight…
const DEPLOY_IDLE_MS = 60 * 1000;     // …and this often otherwise, so a new deploy shows within a minute
const RUN_TTL_MS = 24 * 3600 * 1000;   // release results older than this are dropped on load
const RECHECK_MS = 60 * 1000;           // re-read release PRs' checks this often…
const RECHECK_FOR_MS = 30 * 60 * 1000;  // …for this long after a run, until they settle
const SIGN_POLL_MS = 30 * 1000;         // while a prod release waits for its 2nd signature, look this often…
const SIGN_WATCH_MS = 24 * 3600 * 1000; // …for up to a day
const ROLLBACK_HEAD = /^rollback\/[\d-]+$/; // a Rollback's PR head (release-history.js)
const TO_SIGN_POLL_MS = 60 * 1000;      // an approver with a release waiting on them re-checks this often
const SIGN_PING_MS = 20 * 1000;         // approvers look for a new review request on a release this often (1 search)
const PENDING_SHOWN = 10;
const HISTORY_SHOWN = 10;
const RUNS_SHOWN = 15; // deploy runs per env for the Timeline — same call as the latest-run check
const HISTORY_SCAN = 40; // enough raw history to walk HISTORY_SHOWN first-parent steps

module.exports = function createReleases({ send, ghJson, ghGraphql, stateDir, findLocal, startAgent, whoami, notify, fixRun }) {
  const file = path.join(stateDir, 'releases.json');
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf-8')) || {}; } catch {}
  let state = { source: saved.source || DEFAULT_SOURCE, ...(saved.cache || {}), loading: false };
  if (state.releaseRun && (state.releaseRun.running || Date.now() - state.releaseRun.startedAt > RUN_TTL_MS)) state.releaseRun = null;
  let timer = null, inFlight = false;

  function persist() {
    const { loading, ...cache } = state;
    try { fs.writeFileSync(file, JSON.stringify({ source: state.source, cache }, null, 2)); } catch {}
  }
  function push(patch) {
    state = { ...state, ...patch };
    send({ type: 'releases', state });
  }

  async function loadConfig(source) {
    const src = parseSource(source);
    if (!src) return { error: `Not a valid source: "${source}". Use owner/repo:path/releases.json[@branch] or an absolute path to a .json file.` };
    let text;
    if (src.kind === 'file') {
      try { text = fs.readFileSync(src.path, 'utf-8'); } catch (e) { return { error: `Can't read ${src.path}: ${e.code || e.message}` }; }
    } else {
      // GitHub and any local checkout of that repo, side by side. A local copy with YOUR edits
      // (uncommitted, or committed but not on the source branch yet) wins, so a refresh shows
      // what you just changed; a checkout that's merely behind never overrides GitHub.
      const [res, local] = await Promise.all([
        ghJson(['api', `repos/${src.repo}/contents/${src.path}${src.ref ? `?ref=${src.ref}` : ''}`]),
        findLocal ? findLocal(src.repo, src.path, src.ref) : null,
      ]);
      const readLocal = () => {
        try { return { config: JSON.parse(fs.readFileSync(local.path, 'utf-8')), localOnly: local.path }; }
        catch (e) { return { error: `Config at ${local.path} is not valid JSON: ${e.message}` }; }
      };
      if (local && local.edited) return readLocal();
      if (res.error) return local ? readLocal() : { error: res.error, errorCode: res.errorCode || null };
      if (!res.data || typeof res.data.content !== 'string') {
        // Not on GitHub yet: read it from a local clone so the board works before it's pushed.
        if (local) return readLocal();
        return { error: `No config at ${source}${res.data && res.data.message ? ` (${res.data.message})` : ''} — no access, or the file isn't there yet.` };
      }
      text = Buffer.from(res.data.content, 'base64').toString('utf-8');
    }
    try { return { config: JSON.parse(text) }; } catch (e) { return { error: `Config is not valid JSON: ${e.message}` }; }
  }

  // Every branch tip and every promote count in one GraphQL call. A missing
  // branch comes back as a null ref, not an error, so one bad row can't sink the rest.
  // lists=true is the slower second pass, same single call: the waiting commits behind each
  // count (seen on click) and each env branch's last HISTORY_SHOWN commits (the Timeline tab).
  async function fetchResults(cfg, lists = false) {
    const { commits, compares } = requestsFor(cfg);
    const repos = [...new Set([...commits, ...compares].map(x => x.repo))];
    if (!repos.length) return { results: { commits: {}, compares: {}, history: {} } };
    const q = JSON.stringify;
    const parts = repos.map((repo, i) => {
      const [owner, name] = repo.split('/');
      const tips = commits.filter(c => c.repo === repo).map((c, j) => lists
        ? `h${j}: ref(qualifiedName: ${q('refs/heads/' + c.branch)}) { target { ... on Commit { history(first: ${HISTORY_SCAN}) { nodes { oid messageHeadline messageBody committedDate url parents(first: 1) { nodes { oid } } } } } } }`
        : `t${j}: ref(qualifiedName: ${q('refs/heads/' + c.branch)}) { target { ... on Commit { oid messageHeadline messageBody committedDate url author { name user { login } } } } }`);
      const cmps = compares.filter(c => c.repo === repo).map((c, j) =>
        `c${j}: ref(qualifiedName: ${q('refs/heads/' + c.base)}) { compare(headRef: ${q(c.head)}) { aheadBy${lists ? ` commits(last: ${PENDING_SHOWN}) { nodes { oid messageHeadline messageBody url } }` : ''} } }`);
      return `r${i}: repository(owner: ${q(owner)}, name: ${q(name)}) { ${[...tips, ...cmps].join(' ')} }`;
    });
    const res = await ghGraphql(`query { ${parts.join(' ')} }`);
    const out = { commits: {}, compares: {}, history: {} };
    if (res.error) return { error: res.error, errorCode: res.errorCode || null };
    repos.forEach((repo, i) => {
      const node = res.data[`r${i}`];
      if (lists) commits.filter(c => c.repo === repo).forEach((c, j) => {
        const h = node && node[`h${j}`] && node[`h${j}`].target && node[`h${j}`].target.history;
        out.history[`${repo}|${c.env}`] = h ? firstParentChain(h.nodes, HISTORY_SHOWN).map(n => ({ sha: n.oid, title: commitTitle(n.messageHeadline, n.messageBody), date: n.committedDate, url: n.url })) : [];
      });
      if (!lists) commits.filter(c => c.repo === repo).forEach((c, j) => {
        const key = `${repo}|${c.env}`;
        if (!node) { out.commits[key] = { error: 'Repo not found, or no access' }; return; }
        const t = node[`t${j}`] && node[`t${j}`].target;
        out.commits[key] = !t ? { missing: true } : {
          sha: t.oid, title: commitTitle(t.messageHeadline, t.messageBody), date: t.committedDate, url: t.url,
          author: (t.author && t.author.user && t.author.user.login) || (t.author && t.author.name) || '',
        };
      });
      compares.filter(c => c.repo === repo).forEach((c, j) => {
        const key = `${repo}|${c.from}>${c.to}`;
        const cmp = node && node[`c${j}`] && node[`c${j}`].compare;
        const url = `https://github.com/${repo}/compare/${encodeURIComponent(c.base)}...${encodeURIComponent(c.head)}`;
        out.compares[key] = !cmp ? { to: c.to, error: 'Could not compare these branches', url } : {
          to: c.to, ahead: cmp.aheadBy, url,
          commits: lists ? cmp.commits.nodes.slice().reverse().map(n => ({ sha: n.oid, title: commitTitle(n.messageHeadline, n.messageBody), url: n.url })) : null,
        };
      });
    });
    return { results: out };
  }

  // Last run of each env's deploy workflow on its branch: a CI tag whose pipeline
  // has been red for a year shouldn't read the same as a green one. Query args go
  // through -f, not the URL, because ghJson runs through a shell on Windows ("&").
  async function fetchDeploys(cfg, prev) {
    const out = {};
    await Promise.all(requestsFor(cfg).deploys.map(async (d) => {
      const key = `${d.repo}|${d.env}`;
      const res = await ghJson(['api', '-X', 'GET', `repos/${d.repo}/actions/workflows/${d.file}/runs`, '-f', `branch=${d.branch}`, '-f', `per_page=${RUNS_SHOWN}`]);
      const all = (res.data && res.data.workflow_runs) || [], run = all[0];
      // finished runs for the Timeline: when each deploy went out, who ran it, did it work
      const runs = all.filter(x => x.status === 'completed' && x.conclusion !== 'cancelled' && x.conclusion !== 'skipped').map(x => ({
        sha: x.head_sha, date: x.updated_at, state: x.conclusion, url: x.html_url, actor: (x.actor && x.actor.login) || '',
        title: commitTitle(String((x.head_commit && x.head_commit.message) || x.display_title || '').split('\n')[0], String((x.head_commit && x.head_commit.message) || '').split('\n').slice(2).join('\n')),
      }));
      if (res.error) { out[key] = { state: 'unknown', error: res.error }; return; }
      if (!run) { out[key] = { state: 'never', url: `https://github.com/${d.repo}/actions/workflows/${d.file}` }; return; }
      // repo/branch/name/runNumber/sha/event: what a Fix agent needs (actions-core fixRunPlan)
      const base = { url: run.html_url, date: run.updated_at || run.created_at, runs, repo: d.repo, branch: d.branch, name: run.name || d.file,
        runNumber: run.run_number || 0, sha: run.head_sha || '', event: run.event || '', actor: (run.actor && run.actor.login) || '' };
      if (run.status !== 'completed') { out[key] = { ...base, state: 'running' }; return; }
      // Red run: one more call to learn WHICH job failed — the deploy, or a follow-up after it
      // plus whether it has EVER gone green here: one that never has isn't what deploys this env
      let failed = [], everSucceeded;
      // same red run as last poll: its jobs won't change, skip the two extra calls
      const seen = prev && prev[key];
      if (run.conclusion === 'failure' && seen && seen.url === run.html_url && seen.state !== 'running' && seen.state !== 'unknown') {
        failed = seen.failed || [];
        everSucceeded = seen.state === 'dead' ? false : undefined;
      } else if (run.conclusion === 'failure') {
        const [jobs, wins] = await Promise.all([
          ghJson(['api', `repos/${d.repo}/actions/runs/${run.id}/jobs`]),
          ghJson(['api', '-X', 'GET', `repos/${d.repo}/actions/workflows/${d.file}/runs`, '-f', `branch=${d.branch}`, '-f', 'status=success', '-f', 'per_page=1']),
        ]);
        failed = ((jobs.data && jobs.data.jobs) || []).filter(j => j.conclusion === 'failure').map(j => ({
          job: j.name, step: ((j.steps || []).find(st => st.conclusion === 'failure') || {}).name || '',
        }));
        if (wins.data && typeof wins.data.total_count === 'number') everSucceeded = wins.data.total_count > 0;
      }
      out[key] = { ...base, state: runState(run.conclusion || 'unknown', failed, everSucceeded), failed };
    }));
    return out;
  }

  // What a manually deployed env really runs: the sha pinned in some file (terraform tfvars…),
  // then one compare against the branch for that commit and how many newer ones aren't live.
  async function fetchLives(cfg) {
    const out = {}, files = new Map(); // each pinning file fetched once, however many envs read it
    const read = (from) => {
      if (!files.has(from)) files.set(from, (async () => {
        const src = parseSource(from);
        const res = await ghJson(['api', `repos/${src.repo}/contents/${src.path}${src.ref ? `?ref=${src.ref}` : ''}`]);
        return res.data && typeof res.data.content === 'string' ? Buffer.from(res.data.content, 'base64').toString('utf-8') : null;
      })());
      return files.get(from);
    };
    await Promise.all(requestsFor(cfg).lives.map(async (l) => {
      const key = `${l.repo}|${l.env}`;
      const text = await read(l.from);
      const sha = liveSha(text, l.match);
      if (!sha || !SAFE_REF_RE.test(sha)) { out[key] = { error: text == null ? `Can't read ${l.from}` : `No commit found in ${l.from}` }; return; }
      const cmp = await ghJson(['api', `repos/${l.repo}/compare/${sha}...${l.branch}`]);
      const b = cmp.data && cmp.data.base_commit;
      if (!b) { out[key] = { sha, error: `Commit ${sha} not found in ${l.repo}` }; return; }
      out[key] = {
        sha: b.sha, title: commitTitle(b.commit.message.split('\n')[0], b.commit.message.split('\n').slice(2).join('\n')),
        date: b.commit.committer && b.commit.committer.date, url: b.html_url, from: l.from,
        behind: cmp.data.ahead_by, compareUrl: cmp.data.html_url,
      };
    }));
    return out;
  }

  async function refresh() {
    if (inFlight) return;
    inFlight = true;
    push({ loading: true });
    try {
      // The config almost never changes, so query with last time's copy while the
      // fresh one loads; only a changed config pays for a second round trip.
      const cached = state.config || null;
      const early = cached && fetchResults(cached);
      const loaded = await loadConfig(state.source);
      if (loaded.error) return push({ error: loaded.error, errorCode: loaded.errorCode || null, problems: null, grid: null, config: null });
      const problems = validateConfig(loaded.config);
      if (problems.length) return push({ error: null, errorCode: null, problems, grid: null, config: null });
      const cfg = loaded.config;
      const same = cached && JSON.stringify(cached) === JSON.stringify(cfg);
      const fetched = await (same ? early : fetchResults(cfg));
      if (fetched.error) return push({ error: fetched.error, errorCode: fetched.errorCode, problems: null });
      // keep the previous pass's commit lists on screen until the new ones land
      const prev = (state.results && state.results.compares) || {};
      if (state.results && state.results.deploys) fetched.results.deploys = state.results.deploys;
      if (state.results && state.results.lives) fetched.results.lives = state.results.lives;
      if (state.results && state.results.history) fetched.results.history = state.results.history;
      for (const [k, v] of Object.entries(fetched.results.compares)) if (prev[k] && prev[k].ahead === v.ahead) v.commits = prev[k].commits;
      push({ error: null, errorCode: null, problems: null, localOnly: loaded.localOnly || null, config: cfg, results: fetched.results,
        grid: buildGrid(cfg, fetched.results), updatedAt: Date.now() });
      const [listed, deploys, lives] = await Promise.all([fetchResults(cfg, true), fetchDeploys(cfg, state.results && state.results.deploys), fetchLives(cfg)]);
      if (state.config !== cfg) return;
      const results = { commits: state.results.commits, compares: listed.error ? state.results.compares : listed.results.compares,
        history: listed.error ? state.results.history : listed.results.history, deploys, lives };
      const prevDeploys = state.results.deploys;
      push({ results, grid: buildGrid(cfg, results) });
      deploysChanged(prevDeploys, deploys);
      checkToSign().catch(() => {});
      reconcileHistory().catch(() => {});
    } finally {
      inFlight = false;
      push({ loading: false });
      persist();
    }
  }

  // A deploy just went red: say so once (the transition, not every poll), click opens the run.
  // Between full refreshes, re-read just the deploy runs: every few seconds while one is in
  // flight, every minute otherwise (a red run's job details are reused, so that's 1 call per env).
  let deployTimer = null;
  function deploysChanged(prev, next) {
    for (const k of newDeployFailures(prev, next)) {
      const d = next[k], [repo, env] = k.split('|');
      const why = (d.failed || []).map(f => f.job + (f.step ? ' › ' + f.step : '')).join('; ');
      if (notify) notify(`❌ Deploy failed · ${repo.split('/')[1]} · ${env}`, why || d.name || '', d.url);
    }
    armDeploys(Object.values(next || {}).some(d => d.state === 'running') ? DEPLOYING_MS : DEPLOY_IDLE_MS);
  }
  function armDeploys(ms) {
    clearTimeout(deployTimer);
    deployTimer = setTimeout(async () => {
      const cfg = state.config;
      if (!cfg || inFlight || !state.results) return armDeploys(DEPLOY_IDLE_MS); // a full refresh is on it
      const prevDeploys = state.results.deploys, deploys = await fetchDeploys(cfg, prevDeploys);
      if (state.config !== cfg || inFlight) return armDeploys(DEPLOY_IDLE_MS);
      const results = { ...state.results, deploys };
      push({ results, grid: buildGrid(cfg, results) }); // not updatedAt: only deploys are fresh, opening still does a full refresh
      persist();
      deploysChanged(prevDeploys, deploys);
    }, ms);
    deployTimer.unref?.();
  }

  // Polls even while the modal is closed: the footer badge says when a deploy is failing.
  // Starts late so it stays out of the app's startup rush.
  // Near-instant "a release needs you": every SIGN_PING_MS, one GitHub search for open PRs that
  // ask ME for review (a release asks every other approver). When that set changes, run the full checkToSign (which
  // notifies). Cheap: a single search call, only on approvers' machines.
  let lastPing = null;
  async function signPing() {
    const org = approversOrg();
    if (!org || !state.config || !state.approvers || !state.approvers.isApprover) return;
    const q = `is:pr is:open archived:false org:${org} user-review-requested:@me`;
    const res = await ghGraphql(`query { search(query: ${JSON.stringify(q)}, type: ISSUE, first: 50) { nodes { ... on PullRequest { number repository { nameWithOwner } } } } }`);
    if (!res.data) return;
    const key = res.data.search.nodes.map(n => n.repository.nameWithOwner + '#' + n.number).sort().join(',');
    if (key !== lastPing) { lastPing = key; await checkToSign(); }
  }
  const pingTimer = setInterval(() => signPing().catch(() => {}), SIGN_PING_MS);
  if (pingTimer.unref) pingTimer.unref();

  setTimeout(() => {
    refresh(); timer = setInterval(refresh, REFRESH_MS); timer.unref?.();
    // Overlord restarted while a recent run was still settling: keep watching its PRs
    const r = state.releaseRun;
    if (r && !r.running && Date.now() - r.startedAt < RECHECK_FOR_MS) recheck(r);
  }, 20000).unref?.(); // unref: never the reason a process stays alive

  // ── Prod sign-off (SOC2): the approvers are the `release-approvers` team of the config repo's
  // org. Only its members may release or sign; Overlord merges a prod release PR only once two
  // of them have signed it (signoff-core). Editing the team is GitHub's call (team maintainers).
  // gh hands a failed call's JSON body back as data ({ message, status: "404" }): that's an error too
  const apiErr = (r) => r.error || (r.data && !Array.isArray(r.data) && r.data.message && r.data.status ? `${r.data.message} (${r.data.status})` : null);
  const approversOrg = () => { const src = parseSource(state.source); return src && src.kind === 'gh' ? src.repo.split('/')[0] : null; };
  let me = null; // { github, clickup }
  async function whoAmI() { if (!me || !me.github) me = await whoami().catch(() => ({ github: null, clickup: null })); return me; }

  async function loadApprovers() {
    const org = approversOrg();
    if (!org) return push({ approvers: { error: 'Approvers need a GitHub config source (owner/repo:path)' } });
    const who = await whoAmI();
    const [list, mine] = await Promise.all([
      ghJson(['api', '-X', 'GET', `orgs/${org}/teams/${APPROVERS_TEAM}/members`, '-f', 'per_page=100']),
      who.github ? ghJson(['api', `orgs/${org}/teams/${APPROVERS_TEAM}/memberships/${who.github}`]) : Promise.resolve({ error: 'no gh login' }),
    ]);
    const listErr = apiErr(list), missing = !!listErr && /404|Not Found/i.test(listErr);
    const members = Array.isArray(list.data) ? list.data.map(u => ({ login: u.login, avatar: u.avatar_url })) : [];
    push({ approvers: {
      org, team: APPROVERS_TEAM, exists: !listErr, error: missing ? null : listErr, members,
      me: who.github, meClickup: who.clickup,
      isApprover: !!who.github && members.some(m => m.login.toLowerCase() === who.github.toLowerCase()),
      canEdit: !apiErr(mine) && !!(mine.data && mine.data.role === 'maintainer' && mine.data.state === 'active'),
    } });
  }
  const memberLogins = () => ((state.approvers && state.approvers.members) || []).map(m => m.login);

  async function approversEdit(kind, login) {
    const org = approversOrg();
    if (!org) return;
    let r;
    // fields go as a JSON file: ghJson runs through a shell on Windows, which splits a spaced -f value
    if (kind === 'create') r = await ghJson(['api', '-X', 'POST', `orgs/${org}/teams`, '--input', writeTmp({ name: APPROVERS_TEAM, privacy: 'closed',
      description: 'Approve prod releases: Overlord needs two of these people to sign before a prod release PR merges' })]);
    else if (!/^[A-Za-z0-9-]{1,39}$/.test(String(login || ''))) return send({ type: 'toast', text: 'Not a GitHub username' });
    else if (kind === 'add') r = await ghJson(['api', '-X', 'PUT', `orgs/${org}/teams/${APPROVERS_TEAM}/memberships/${login}`, '-f', 'role=member']);
    else r = await ghJson(['api', '-X', 'DELETE', `orgs/${org}/teams/${APPROVERS_TEAM}/memberships/${login}`]);
    // a DELETE answers 204 with no body: ghJson reports that as an unparsable reply, not a failure
    const e = apiErr(r);
    if (e && !(kind === 'remove' && /Unexpected end|JSON/i.test(e))) send({ type: 'toast', text: `Approvers: ${e}` });
    await loadApprovers();
  }

  // Fresh sign-off of one PR (always re-read — this is what gates a merge)
  async function signoffOf(repo, n) {
    const [pr, rv] = await Promise.all([ghJson(['api', `repos/${repo}/pulls/${n}`]),
      ghJson(['api', '-X', 'GET', `repos/${repo}/pulls/${n}/reviews`, '-f', 'per_page=100'])]);
    if (apiErr(pr) || !pr.data) return { error: apiErr(pr) || 'PR not found' };
    return { pr: pr.data, ...signoff(pr.data, rv.data || [], memberLogins()) };
  }

  // Is this PR a prod release step of the config (target = a prod branch, head = its promote source)?
  function prodStep(repo, base, head) {
    const cfg = state.config;
    if (!cfg) return null;
    return releasePlan(cfg, ['prod']).prs.find(p => p.repo.toLowerCase() === repo.toLowerCase() && p.target === base && (p.source === head || ROLLBACK_HEAD.test(head))) || null;
  }

  // The gate every Overlord merge goes through: prod release PRs need two approvers' signatures.
  async function mergeGate(url) {
    const m = String(url).match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
    if (!m) return { ok: true };
    const pr = await ghJson(['api', `repos/${m[1]}/pulls/${m[2]}`]);
    if (!state.config) await refresh(); // just launched: never let a merge through before the config is known
    if (!state.config) return { ok: false, reason: "release config not loaded yet: open Releases once, then retry" };
    // fail closed: a PR we can't read might be a prod release PR
    if (!pr.data || !pr.data.base || !pr.data.head) return { ok: false, reason: "couldn't read the PR to verify its release sign-off: " + (pr.error || (pr.data && pr.data.message) || "no reply") };
    if (!prodStep(m[1], pr.data.base.ref, pr.data.head.ref)) return { ok: true }; // not a prod release PR
    if (!state.approvers || !state.approvers.exists) await loadApprovers();
    const s = await signoffOf(m[1], m[2]);
    if (s.error) return { ok: false, reason: s.error };
    return s.ok ? { ok: true, signoff: s } : { ok: false, reason: `prod release needs ${s.need} approvers' signatures (has ${s.count}${s.count ? ': ' + s.signers.map(x => '@' + x.login).join(', ') : ''})` };
  }

  // Prod release PRs open right now that are waiting on MY signature — found from the config, so
  // an approver who didn't run the release still sees it (release runs are per machine). A new
  // one raises a notification; clicking it opens Releases. Re-checked every minute while any wait.
  let toSignTimer = null, notifiedToSign = new Set();
  async function checkToSign() {
    clearTimeout(toSignTimer);
    const cfg = state.config;
    if (!cfg) return;
    if (!state.approvers || state.approvers.members === undefined) await loadApprovers();
    const who = await whoAmI();
    if (!state.approvers.isApprover || !who.github) { if ((state.toSign || []).length) push({ toSign: [] }); return; }
    const steps = releasePlan(cfg, ['prod']).prs;
    const found = [];
    await Promise.all(steps.map(async (p) => {
      const r = await ghJson(['api', '-X', 'GET', `repos/${p.repo}/pulls`, '-f', 'state=open', '-f', `base=${p.target}`, '-f', 'per_page=100']);
      const prs = (Array.isArray(r.data) ? r.data : []).filter(x => x.head && (x.head.ref === p.source || ROLLBACK_HEAD.test(x.head.ref))
        && (!x.head.repo || x.head.repo.full_name.toLowerCase() === p.repo.toLowerCase()));
      for (const pr of prs) {
        const s = await signoffOf(p.repo, pr.number);
        if (s.error || hasSigned(s, who.github) || s.pr.user.login.toLowerCase() === who.github.toLowerCase()) continue;
        found.push({ repo: p.repo, label: p.label + (ROLLBACK_HEAD.test(pr.head.ref) ? ' (rollback)' : ''), number: pr.number, url: pr.html_url,
          signers: s.signers.map(x => x.login), count: s.count, need: s.need });
      }
    }));
    found.sort((a, b) => a.label.localeCompare(b.label));
    push({ toSign: found });
    const fresh = found.filter(f => !notifiedToSign.has(f.repo + '#' + f.number));
    if (fresh.length && notify) {
      const by = [...new Set(found.flatMap(f => f.signers))].map(x => '@' + x).join(', ');
      notify(`✍ Prod release waiting for your signature`, `${found.length} PR${found.length === 1 ? '' : 's'}: ${found.map(f => f.label).join(', ')}${by ? ' · opened by ' + by : ''}`,
        found[0].url, () => send({ type: 'releases', state, open: true }));
    }
    notifiedToSign = new Set(found.map(f => f.repo + '#' + f.number));
    if (found.length) { toSignTimer = setTimeout(() => checkToSign().catch(() => {}), TO_SIGN_POLL_MS); if (toSignTimer.unref) toSignTimer.unref(); }
  }

  // Sign: approve every open prod release PR waiting on me — from the last run here, and any found
  // by checkToSign (a release someone else opened).
  async function signRelease() {
    const who = await whoAmI();
    await loadApprovers();
    if (!state.approvers.isApprover) return send({ type: 'toast', text: 'Only release approvers can sign' });
    const run = state.releaseRun;
    const targets = new Map();
    for (const r of ((run && run.rows) || [])) if (r.env === 'prod' && r.pr && !r.merged && !r.closed) targets.set(r.repo + '#' + r.pr.number, { repo: r.repo, label: r.label, number: r.pr.number });
    for (const t of (state.toSign || [])) targets.set(t.repo + '#' + t.number, { repo: t.repo, label: t.label, number: t.number });
    let signed = 0;
    for (const t of targets.values()) {
      const s = await signoffOf(t.repo, t.number);
      if (s.error || hasSigned(s, who.github)) continue;
      if (s.pr.user.login.toLowerCase() === who.github.toLowerCase()) continue; // the opener already signed by opening it
      const res = await ghJson(['api', '-X', 'POST', `repos/${t.repo}/pulls/${t.number}/reviews`, '--input',
        writeTmp({ event: 'APPROVE', commit_id: s.pr.head.sha, body: reviewMark(who.clickup) })]);
      if (apiErr(res)) { send({ type: 'toast', text: `Sign ${t.label}: ${apiErr(res)}` }); continue; }
      signed++;
      const i = run ? run.rows.findIndex(r => r.repo === t.repo && r.pr && r.pr.number === t.number) : -1;
      if (i >= 0) {
        const after = await signoffOf(t.repo, t.number);
        if (!after.error) run.rows[i] = { ...run.rows[i], signoff: { signers: after.signers, count: after.count, need: after.need, ok: after.ok } };
      }
    }
    if (run) push({ releaseRun: { ...run } });
    persist();
    await checkToSign().catch(() => {});
    reconcileHistory().catch(() => {});
    send({ type: 'toast', text: signed ? `Signed ${signed} prod release PR${signed === 1 ? '' : 's'}` : 'Nothing left for you to sign' });
  }

  // Merge every prod/alpha release PR that's ready: signed (prod), mergeable, checks not failing.
  async function mergeReady() {
    const run = state.releaseRun;
    let merged = 0;
    for (const [r, i] of ((run && run.rows) || []).map((r, i) => [r, i])) {
      if (!r.pr || r.merged || r.closed || r.status === 'blocked' || r.status === 'error' || r.conflict !== false) continue;
      const gate = await mergeGate(`https://github.com/${r.repo}/pull/${r.pr.number}`);
      if (!gate.ok) continue;
      const res = await ghJson(['api', '-X', 'PUT', `repos/${r.repo}/pulls/${r.pr.number}/merge`, '-f', 'merge_method=merge']);
      if (apiErr(res)) { send({ type: 'toast', text: `Merge ${r.label} ${r.env}: ${apiErr(res)}` }); continue; }
      merged++;
      run.rows[i] = { ...r, merged: true, status: 'merged' };
    }
    push({ releaseRun: { ...run } }); persist();
    send({ type: 'toast', text: merged ? `Merged ${merged} release PR${merged === 1 ? '' : 's'}` : 'Nothing ready to merge' });
  }
  // Release history: manifests in <org>/release-manifests (release-history.js)
  const requestReviews = async (repo, n) => {
    const who = await whoAmI();
    const others = memberLogins().filter(m => m.toLowerCase() !== String(who.github).toLowerCase());
    if (others.length) await ghJson(['api', '-X', 'POST', `repos/${repo}/pulls/${n}/requested_reviewers`, '--input', writeTmp({ reviewers: others })]);
  };
  const history = createHistory({ ghJson, writeTmp: (p) => writeTmp(p), push, getState: () => state, org: () => approversOrg(),
    signoffOf, requestReviews, whoAmI, send });
  let reconciling = false;
  const reconcileHistory = async () => { if (reconciling) return; reconciling = true; try { await history.reconcile(); } finally { reconciling = false; } };

  // Merge a pending release straight from the history: every open PR of it that the gate allows.
  async function mergeRelease(id) {
    const m = ((state.history && state.history.items) || []).find(x => x.id === id);
    if (!m) return;
    let merged = 0;
    for (const r of m.repos.filter(x => !x.mergeSha && !x.closed)) {
      const gate = await mergeGate(r.pr.url);
      if (!gate.ok) { send({ type: 'toast', text: `${r.label}: ${gate.reason}` }); continue; }
      const res = await ghJson(['api', '-X', 'PUT', `repos/${r.repo}/pulls/${r.pr.number}/merge`, '-f', 'merge_method=merge']);
      if (apiErr(res)) { send({ type: 'toast', text: `Merge ${r.label}: ${apiErr(res)}` }); continue; }
      merged++;
    }
    await reconcileHistory();
    send({ type: 'toast', text: merged ? `Release ${id}: merged ${merged} PR${merged === 1 ? '' : 's'}` : `Release ${id}: nothing merged` });
  }

  const writeTmp = (payload) => { const p = path.join(runsDir(), `api-${stamp()}-${Math.random().toString(36).slice(2, 7)}.json`); fs.writeFileSync(p, JSON.stringify(payload)); return p; };

  // The config repo's local checkout (where the frontend's flag-gap check and a Fix agent work),
  // else the home dir.
  async function configCheckout() {
    const src = parseSource(state.source);
    if (src && src.kind === 'file') return path.dirname(src.path);
    if (src && src.kind === 'gh' && findLocal) {
      const local = await findLocal(src.repo, src.path, src.ref);
      if (local) return local.path.slice(0, local.path.length - src.path.length).replace(/[\\/]+$/, '');
    }
    return os.homedir();
  }
  const runsDir = () => { const d = path.join(stateDir, 'release-runs'); fs.mkdirSync(d, { recursive: true }); return d; };
  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');

  // Release button, deterministic: every PR of the plan opened/reused + back-merges + mergeable
  // and checks state, streamed into state.releaseRun row by row. No agent unless a row is
  // blocked and someone presses its Fix.
  async function release(envs) {
    const cfg = state.config;
    const targets = cfg ? releaseTargets(cfg) : [];
    envs = (Array.isArray(envs) ? envs : []).filter(e => targets.includes(e));
    if (!cfg || !envs.length) { send({ type: 'toast', text: 'Nothing to release: pick an environment first' }); return; }
    if (state.releaseRun && state.releaseRun.running) { send({ type: 'toast', text: 'A release is already running' }); return; }
    await loadApprovers();
    if (!state.approvers.isApprover) { send({ type: 'toast', text: 'Only release approvers can release — see 👥 Approvers' }); return; }
    const plan = releasePlan(cfg, envs);
    const run = { envs, startedAt: Date.now(), running: true, rows: plan.prs.map(p => ({ ...p, running: true })), manual: plan.manual, flags: null };
    push({ releaseRun: run });
    const cwd = await configCheckout();
    const flagScript = path.join(cwd, '.claude', 'skills', 'release', 'flag-gap.cjs');
    const flags = envs.includes('prod') && fs.existsSync(flagScript) ? flagGap(cwd, flagScript) : Promise.resolve(null);
    let n = 0;
    const writeJson = (payload) => { const p = path.join(runsDir(), `pr-${stamp()}-${n++}.json`); fs.writeFileSync(p, JSON.stringify(payload)); return p; };
    const onRow = (i, row) => { run.rows[i] = { ...row }; push({ releaseRun: { ...run } }); };
    const members = memberLogins(), who = await whoAmI();
    const prs = plan.prs.map(p => p.env === 'prod' ? { ...p, members, opener: { login: who.github, clickup: who.clickup } } : p);
    await runRelease(ghJson, prs, { writeJson, onRow });
    run.flags = await flags;
    // missing prod flags: say so at the top of every open prod release PR (opened now or in an
    // earlier run), once — a PR that already carries the warning is left alone
    if (run.flags && run.flags.missing && run.flags.missing.length) {
      const warn = `> ⚠ **Seed before merging:** prod is missing the feature flag${run.flags.missing.length === 1 ? '' : 's'} ${run.flags.missing.map(k => '\`' + k + '\`').join(', ')}. `
        + 'Dry run first: `cd C:/Work/back-office && node server/scripts/syncFlagCatalog.js --only <Key> --allow-prod`, then `--apply`.\n\n';
      await Promise.all(run.rows.filter(r => r.env === 'prod' && r.pr && !r.merged && !r.closed).map(async (r) => {
        const cur = r.body != null ? { data: { body: r.body } } : await ghJson(['api', `repos/${r.repo}/pulls/${r.pr.number}`]);
        const body = (cur.data && cur.data.body) || '';
        if (cur.error || body.includes('Seed before merging')) return;
        await ghJson(['api', '-X', 'PATCH', `repos/${r.repo}/pulls/${r.pr.number}`, '--input', writeJson({ body: warn + body })]);
      }));
    }
    // a prod release PR I opened elsewhere (or before sign-off existed) gets my opener line now,
    // so it carries my signature's ClickUp id like one Overlord opened
    // ask the other approvers to review every open prod release PR: GitHub notifies them right away
    // (mail, mobile), and each one's Overlord sees the request within SIGN_PING_MS. People, not the
    // team: requesting a team needs the team to have access to every repo, people already do.
    const others = members.filter(m => m.toLowerCase() !== String(who.github).toLowerCase());
    if (others.length) await Promise.all(run.rows.filter(r => r.env === 'prod' && r.pr && !r.merged && !r.closed).map(r =>
      ghJson(['api', '-X', 'POST', `repos/${r.repo}/pulls/${r.pr.number}/requested_reviewers`, '--input', writeJson({ reviewers: others })])));
    await Promise.all(run.rows.filter(r => r.env === 'prod' && r.pr && r.reused && !r.merged && !r.closed).map(async (r) => {
      const cur = await ghJson(['api', `repos/${r.repo}/pulls/${r.pr.number}`]);
      const p = cur.data;
      if (apiErr(cur) || !p || !p.user || p.user.login.toLowerCase() !== String(who.github).toLowerCase() || OPENER_RE.test(p.body || '')) return;
      await ghJson(['api', '-X', 'PATCH', `repos/${r.repo}/pulls/${r.pr.number}`, '--input', writeJson({ body: (p.body || '') + '\n\n' + openerMark(who.github, who.clickup) })]);
    }));
    run.running = false;
    for (const r of run.rows) delete r.body; // only needed for that patch
    push({ releaseRun: { ...run } });
    persist();
    recheck(run);
    // the shared record: this release's manifest in <org>/release-manifests
    const lives = (state.results && state.results.lives) || {};
    await history.recordRun(run, { opener: { login: who.github, clickup: who.clickup }, flags: run.flags,
      manual: run.manual.map(m => ({ ...m, live: lives[`${m.repo}|${m.env}`] && !lives[`${m.repo}|${m.env}`].error
        ? { sha: lives[`${m.repo}|${m.env}`].sha, behind: lives[`${m.repo}|${m.env}`].behind } : null })) }).catch(e => send({ type: 'toast', text: 'Release manifest: ' + e.message }));
    const blocked = run.rows.filter(r => r.status === 'blocked' || r.status === 'error').length;
    const opened = run.rows.filter(r => r.pr && !r.reused).length;
    send({ type: 'toast', text: `Release ${envs.join(' + ')}: ${opened} PR${opened === 1 ? '' : 's'} opened${blocked ? `, ${blocked} blocked` : ''}` });
  }

  // After a run: a fresh PR's own checks only start once it exists, so re-read every open row
  // each minute until nothing is pending or unknown (or half an hour passes, or a new run starts).
  let recheckTimer = null;
  function recheck(run) {
    clearTimeout(recheckTimer);
    const unsigned = (r) => r.env === 'prod' && r.signoff && !r.signoff.ok;
    const settled = (r) => !r.pr || r.merged || r.closed || (r.checks !== 'pending' && r.checks !== 'none' && r.conflict !== null && !unsigned(r));
    const tick = async () => {
      if (state.releaseRun !== run && (!state.releaseRun || state.releaseRun.startedAt !== run.startedAt)) return;
      const cur = state.releaseRun;
      const open = cur.rows.map((r, i) => [r, i]).filter(([r]) => !settled(r));
      const signing = cur.rows.some(r => !r.merged && !r.closed && unsigned(r));
      if (!open.length || Date.now() - cur.startedAt > (signing ? SIGN_WATCH_MS : RECHECK_FOR_MS)) return;
      await Promise.all(open.map(async ([r, i]) => {
        const h = await prHealth(ghJson, r.repo, r.pr.number, r.target, undefined, r.env === 'prod' ? memberLogins() : null);
        const row = { ...r, ...h };
        row.status = rowStatus(row);
        cur.rows[i] = row;
      }));
      push({ releaseRun: { ...cur, checkedAt: Date.now() } });
      persist();
      recheckTimer = setTimeout(tick, signing ? SIGN_POLL_MS : RECHECK_MS);
      if (recheckTimer.unref) recheckTimer.unref();
    };
    recheckTimer = setTimeout(tick, RECHECK_MS);
    if (recheckTimer.unref) recheckTimer.unref();
  }

  // The frontend's prod feature-flag gap check, when this machine has it. Read-only.
  function flagGap(cwd, script) {
    return new Promise((resolve) => {
      execFile('node', [script], { cwd, timeout: 120000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          try { const j = JSON.parse(stdout); resolve({ missing: (j.catalogueMissingOnProd || []).map(x => x.key) }); }
          catch { resolve({ error: String(stderr || (err && err.message) || 'no output').trim().split('\n').pop().slice(0, 200) }); }
        });
    });
  }

  // Fix all: one agent for every blocked row of the last run.
  async function fixAll() {
    const rows = ((state.releaseRun && state.releaseRun.rows) || []).filter(r => r.status === 'blocked' || r.status === 'error');
    if (!rows.length) return;
    const p = path.join(runsDir(), `fix-release-${stamp()}.md`);
    fs.writeFileSync(p, releaseFixBrief({ rows, configSource: state.source }));
    const prompt = `Unblock the release: ${rows.length} blocked. Read and follow ${p.replace(/\\/g, '/')} and end with its report table.`;
    startAgent(await configCheckout(), prompt.replace(/[^\w\s.,:/#@()'=+-]/g, '').replace(/\s+/g, ' '));
  }

  function handle(msg) {
    switch (msg && msg.type) {
      case 'releasesOpen':
        send({ type: 'releases', state });
        loadApprovers().catch(() => {});
        // reopened within a minute: what's on screen is fresh enough, the timer takes it from here
        if (!state.updatedAt || Date.now() - state.updatedAt > 60000) refresh();
        return true;
      case 'releasesClose': return true;
      case 'releasesRefresh': refresh(); return true;
      case 'releasesRelease': release(msg.envs).catch(e => { if (state.releaseRun) push({ releaseRun: { ...state.releaseRun, running: false } }); send({ type: 'toast', text: 'Release failed: ' + (e.message || 'error') }); }); return true;
      case 'releasesFix': fixAll().catch(e => send({ type: 'toast', text: 'Fix failed: ' + (e.message || 'error') })); return true;
      case 'releasesApprovers': loadApprovers().catch(() => {}); return true;
      case 'releasesApproversEdit': approversEdit(msg.kind, msg.login).catch(e => send({ type: 'toast', text: 'Approvers: ' + e.message })); return true;
      case 'releasesSign': signRelease().catch(e => send({ type: 'toast', text: 'Sign failed: ' + (e.message || 'error') })); return true;
      case 'releasesMerge': mergeReady().catch(e => send({ type: 'toast', text: 'Merge failed: ' + (e.message || 'error') })); return true;
      case 'releasesFixDeploy': { // Fix on a failed deploy cell: same agent as the Actions list's Fix
        const d = state.results && state.results.deploys && state.results.deploys[msg.key];
        if (d && fixRun) fixRun(d).catch(e => send({ type: 'toast', text: 'Fix failed: ' + (e.message || 'error') }));
        return true;
      }
      case 'releasesHistory': history.load().then(() => reconcileHistory()).catch(e => push({ history: { error: e.message, items: [] } })); return true;
      case 'releasesRollback': history.rollback(msg.id, msg.skip || []).catch(e => send({ type: 'toast', text: 'Rollback failed: ' + e.message })); return true;
      case 'releasesImport': history.importPast(state.config ? releasePlan(state.config, ['prod']).prs : []).then(() => reconcileHistory()).catch(e => send({ type: 'toast', text: 'Import failed: ' + e.message })); return true;
      case 'releasesMergeRelease': mergeRelease(msg.id).catch(e => send({ type: 'toast', text: 'Merge failed: ' + e.message })); return true;
      case 'releasesClearRun': clearTimeout(recheckTimer); push({ releaseRun: null }); persist(); return true;
      case 'releasesSetSource': {
        const source = String(msg.source || '').trim() || DEFAULT_SOURCE;
        push({ source, grid: null, problems: null, error: null, updatedAt: null, config: null, results: null });
        persist();
        refresh();
        return true;
      }
      default: return false;
    }
  }

  return { handle, mergeGate };
};
