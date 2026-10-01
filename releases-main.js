// Main-process side of the Releases board. Owns its own state file so removing
// the feature is deleting the releases-* files plus two hook lines in main.js.
// Renderer contract: receives releasesOpen / releasesClose / releasesRefresh /
// releasesSetSource, sends { type: 'releases', state }.

const fs = require('fs');
const path = require('path');
const { releaseFixBrief } = require('./release-playbook');
const { runRelease, prHealth, rowStatus } = require('./release-run');
const createHistory = require('./release-history');
const { signoff, releaseSignoff, reviewMark, hasSigned, openerMark, OPENER_LINE_RE } = require('./signoff-core');
const { releaseIdOf } = require('./manifest-core');
const APPROVERS_TEAM = 'release-approvers'; // GitHub team in the config repo's org: who may release + sign prod
const { execFile } = require('child_process');
const os = require('os');
const { releaseTargets, releasePlan, releaseWaves, versionAtLeast, manualLeft } = require('./releases-core');
const { newDeployFailures, parseSource, validateConfig, requestsFor, buildGrid, commitTitle, firstParentChain, runState, liveSha, SAFE_REF_RE, DEFAULT_SOURCE, OLD_SOURCE } = require('./releases-core');

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
const SIGN_PING_MS = 5 * 1000;          // approvers look for a new review request / release-manifests change this often (1 GraphQL call)
const PENDING_SHOWN = 10;
const HISTORY_SHOWN = 10;
const RUNS_SHOWN = 15; // deploy runs per env for the Timeline — same call as the latest-run check
const HISTORY_SCAN = 40; // enough raw history to walk HISTORY_SHOWN first-parent steps

module.exports = function createReleases({ send, ghJson, ghGraphql, stateDir, findLocal, startAgent, whoami, notify, fixRun }) {
  const file = path.join(stateDir, 'releases.json');
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf-8')) || {}; } catch {}
  let state = { ...(saved.cache || {}), source: !saved.source || saved.source === OLD_SOURCE ? DEFAULT_SOURCE : saved.source, loading: false };
  if (state.releaseRun && (state.releaseRun.running || Date.now() - state.releaseRun.startedAt > RUN_TTL_MS)) state.releaseRun = null;
  // Overlord quit mid Release all: say so, offer Resume (it picks up with what's still open)
  if (state.releaseAll && state.releaseAll.running) state.releaseAll = { ...state.releaseAll, running: false, status: 'interrupted', detail: 'Overlord closed mid-release', manualWave: null };
  state.teamRun = null;
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
      out[key] = await liveAt(l.repo, l.branch, sha, { from: l.from });
    }));
    // hand-deployed envs with no pin: the last deploy someone confirmed in Release all (confirmed.json)
    const confirmed = await history.confirmed().catch(() => ({}));
    await Promise.all((cfg.repos || []).flatMap(r => Object.entries(r.deploy || {}).filter(([env, how]) => how === 'manual' && r.branches && r.branches[env] && !(r.live && r.live[env]))
      .map(async ([env]) => {
        const c = confirmed[`${r.repo}|${env}`];
        if (c && SAFE_REF_RE.test(c.sha)) out[`${r.repo}|${env}`] = await liveAt(r.repo, r.branches[env], c.sha, { confirmed: { by: c.by, at: c.at } });
      })));
    return out;
  }
  // sha is what's live; how far the branch is ahead of it
  async function liveAt(repo, branch, sha, extra) {
    const cmp = await ghJson(['api', `repos/${repo}/compare/${sha}...${branch}`]);
    const b = cmp.data && cmp.data.base_commit;
    if (!b) return { sha, error: `Commit ${sha} not found in ${repo}` };
    return {
      sha: b.sha, title: commitTitle(b.commit.message.split('\n')[0], b.commit.message.split('\n').slice(2).join('\n')),
      date: b.commit.committer && b.commit.committer.date, url: b.html_url, ...extra,
      behind: cmp.data.ahead_by, compareUrl: cmp.data.html_url,
    };
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
      push({ appVersion: APP_VERSION, error: null, errorCode: null, problems: null, localOnly: loaded.localOnly || null, config: cfg, results: fetched.results,
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
  // The same call watches <org>/release-manifests' head: every sign, merge or new release writes a
  // manifest, so a new commit there = something changed for the team → reload history, re-read the
  // run, re-check what waits on me. That's what makes a teammate's signature show up here within seconds.
  let lastPing = null, lastManifests = null;
  async function signPing() {
    const org = approversOrg();
    if (!org || !state.config || !state.approvers || !state.approvers.isApprover) return;
    const q = `is:pr is:open archived:false org:${org} user-review-requested:@me`;
    const res = await ghGraphql(`query { search(query: ${JSON.stringify(q)}, type: ISSUE, first: 50) { nodes { ... on PullRequest { number repository { nameWithOwner } } } }`
      + ` manifests: repository(owner: ${JSON.stringify(org)}, name: "release-manifests") { ref(qualifiedName: "main") { target { oid } } } }`);
    if (!res.data) return;
    const key = res.data.search.nodes.map(n => n.repository.nameWithOwner + '#' + n.number).sort().join(',');
    const man = res.data.manifests && res.data.manifests.ref && res.data.manifests.ref.target.oid;
    const manChanged = man && lastManifests && man !== lastManifests;
    lastManifests = man || lastManifests;
    if (manChanged) await Promise.all([history.load(), refreshRun(), loadTeamRun()]).catch(() => {});
    if (key !== lastPing || manChanged) { lastPing = key; await checkToSign(); }
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
      org, team: APPROVERS_TEAM, exists: !listErr, error: missing ? null : listErr, members, loadedAt: Date.now(),
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
    const cfgSteps = releasePlan(state.config, ['prod']).prs;
    const back = cfgSteps.find(p => p.repo.toLowerCase() === m[1].toLowerCase() && p.source === pr.data.base.ref && p.target === pr.data.head.ref);
    if (back) return { ok: true, warn: `Back-merge into ${back.source}: the open ${back.target} release PR takes these commits too` };
    if (!prodStep(m[1], pr.data.base.ref, pr.data.head.ref)) return { ok: true }; // not a prod release PR
    if (!state.approvers || !state.approvers.exists) await loadApprovers();
    const s = await releaseSignoffOf(m[1], m[2]);
    if (s.error) return { ok: false, reason: s.error };
    return s.ok ? { ok: true, signoff: s } : { ok: false, reason: `the release needs ${s.need} approvers' signatures (has ${s.count}${s.count ? ': ' + s.signers.map(x => '@' + x.login).join(', ') : ''})${gapsText(s)}` };
  }
  const gapsText = (s) => (s.gaps || []).map(g => ` · @${g.login} still to sign ${g.missing.map(x => x.label + (x.older ? ' (new commits)' : '')).join(', ')}`).join('');

  // The release is signed as one (signoff-core releaseSignoff): this PR's sign-off together with
  // every other still-open PR of its release (the release-id its body carries → the manifest).
  async function releaseSignoffOf(repo, n) {
    const s = await signoffOf(repo, n);
    if (s.error) return s;
    const id = releaseIdOf(s.pr.body);
    if (id && !((state.history && state.history.items) || []).some(x => x.id === id)) await history.load().catch(() => {});
    const man = id && ((state.history && state.history.items) || []).find(x => x.id === id);
    const label = (r) => (man && (man.repos.find(x => x.repo === r) || {}).label) || r.split('/')[1];
    const list = [{ label: label(repo), signoff: s }];
    for (const r of (man ? man.repos : [])) {
      if (r.mergeSha || r.closed || (r.repo === repo && r.pr.number === Number(n))) continue;
      const o = await signoffOf(r.repo, r.pr.number);
      if (o.error) return o;
      if (o.pr.state === 'open') list.push({ label: r.label, signoff: o });
    }
    return releaseSignoff(list);
  }
  // A run's prod PRs are one release: stamp its release-level sign-off for the UI
  function stampSignoff(run) {
    const prs = run.rows.filter(r => r.env === 'prod' && r.pr && !r.merged && !r.closed && r.signoff);
    run.signoff = prs.length ? releaseSignoff(prs) : null;
    return run;
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
    const found = [], all = [];
    await Promise.all(steps.map(async (p) => {
      const r = await ghJson(['api', '-X', 'GET', `repos/${p.repo}/pulls`, '-f', 'state=open', '-f', `base=${p.target}`, '-f', 'per_page=100']);
      const prs = (Array.isArray(r.data) ? r.data : []).filter(x => x.head && (x.head.ref === p.source || ROLLBACK_HEAD.test(x.head.ref))
        && (!x.head.repo || x.head.repo.full_name.toLowerCase() === p.repo.toLowerCase()));
      for (const pr of prs) {
        const s = await signoffOf(p.repo, pr.number);
        if (s.error) continue;
        const meL = String(who.github).toLowerCase();
        all.push({ label: p.label, release: releaseIdOf(s.pr.body) || p.repo + '#' + pr.number, signoff: s, number: pr.number, url: pr.html_url,
          mine: hasSigned(s, who.github), older: (s.stale || []).some(l => l.toLowerCase() === meL) });
        if (hasSigned(s, who.github)) continue; // (a PR I opened counts until new commits land on it)
        found.push({ repo: p.repo, label: p.label + (ROLLBACK_HEAD.test(pr.head.ref) ? ' (rollback)' : ''), number: pr.number, url: pr.html_url, head: s.pr.head.sha, commits: s.pr.commits || null, author: s.pr.user.login,
          release: all[all.length - 1].release, signers: s.signers.map(x => x.login), count: s.count, need: s.need });
      }
    }));
    // the counts people see are the release's (signed as one), not each PR's
    for (const f of found) {
      const rs = releaseSignoff(all.filter(x => x.release === f.release));
      Object.assign(f, { signers: rs.signers.map(x => x.login), count: rs.count });
    }
    found.sort((a, b) => a.label.localeCompare(b.label));
    // the prompt shows each release whole: every repo in it, and which ones still need me
    const toSignReleases = [...new Set(found.map(f => f.release))].map(id => ({ id, repos: all.filter(x => x.release === id)
      .map(x => ({ label: x.label, number: x.number, url: x.url, mine: x.mine, older: x.older })).sort((a, b) => a.label.localeCompare(b.label)) }));
    push({ toSign: found, toSignReleases });
    // what counts as "new" (re-notify, re-open the prompt after Later): a new release or a new PR in it —
    // not new commits, which keep a release signed (signoff-core) and land all day while it's open
    const nkey = (f) => f.release + ':' + f.repo + '#' + f.number;
    const fresh = found.filter(f => !notifiedToSign.has(nkey(f)));
    if (fresh.length && notify) {
      const by = [...new Set(found.flatMap(f => f.signers))].map(x => '@' + x).join(', ');
      notify(`✍ Prod release waiting for your signature`, `${found.length} PR${found.length === 1 ? '' : 's'}: ${found.map(f => f.label).join(', ')}${by ? ' · opened by ' + by : ''}`,
        found[0].url, () => send({ type: 'releases', state, open: true }));
    }
    // the prompt's identity: a new release / a new PR in it = a new key = the big prompt shows again
    const promptKey = found.map(nkey).sort().join(',');
    if (promptKey !== state.signPromptKey) push({ signPromptKey: promptKey });
    notifiedToSign = new Set(found.map(nkey));
    if (found.length) { toSignTimer = setTimeout(() => checkToSign().catch(() => {}), TO_SIGN_POLL_MS); if (toSignTimer.unref) toSignTimer.unref(); }
  }

  // My opener signature on a PR I opened, stamped with its head commit now (new commits void it;
  // GitHub won't let me approve my own PR, so this line is how I sign it). false: not mine / unreadable.
  async function stampOpener(repo, n, who) {
    const cur = await ghJson(['api', `repos/${repo}/pulls/${n}`]);
    const p = cur.data;
    if (apiErr(cur) || !p || !p.user || !p.head || p.user.login.toLowerCase() !== String(who.github).toLowerCase()) return false;
    const body = p.body || '', mark = openerMark(who.github, who.clickup, p.head.sha);
    if (body.includes(mark)) return true;
    const next = OPENER_LINE_RE.test(body) ? body.replace(OPENER_LINE_RE, () => mark) : body + '\n\n' + mark;
    return !apiErr(await ghJson(['api', '-X', 'PATCH', `repos/${repo}/pulls/${n}`, '--input', writeTmp({ body: next })]));
  }

  // Sign: approve every open prod release PR waiting on me — from the last run here, and any found
  // by checkToSign (a release someone else opened).
  // Signing shows at once (state.signing → the buttons say "Signing…"); the team list is reused when
  // it's fresh — re-reading it cost two GitHub calls before anything happened.
  async function signRelease() {
    if (state.signing) return;
    push({ signing: true });
    try { await signNow(); } finally { push({ signing: false }); }
  }
  async function signNow() {
    const who = await whoAmI();
    if (!state.approvers || !state.approvers.loadedAt || Date.now() - state.approvers.loadedAt > 5 * 60 * 1000) await loadApprovers();
    if (!state.approvers.isApprover) return send({ type: 'toast', text: 'Only release approvers can sign' });
    if (!versionOk()) return send({ type: 'toast', text: outdatedMsg() });
    const run = state.releaseRun;
    const targets = new Map();
    for (const r of ((run && run.rows) || [])) if (r.env === 'prod' && r.pr && !r.merged && !r.closed) targets.set(r.repo + '#' + r.pr.number, { repo: r.repo, label: r.label, number: r.pr.number });
    for (const t of (state.toSign || [])) targets.set(t.repo + '#' + t.number, { repo: t.repo, label: t.label, number: t.number });
    // every PR at once: one signature for the whole release. Each one that lands shows right away:
    // the History item gets me as its signer, the prompt ticks the repo, it leaves my to-sign list
    const done = [], failed = [];
    const meL = who.github.toLowerCase();
    const signed = (t) => {
      done.push(t);
      const h = state.history;
      const items = h && h.items && h.items.map(m => !m.repos.some(r => r.repo === t.repo && r.pr.number === t.number) ? m
        : { ...m, repos: m.repos.map(r => r.repo === t.repo && r.pr.number === t.number && !(r.signers || []).some(l => l.toLowerCase() === meL)
          ? { ...r, signers: (r.signers || []).concat(who.github) } : r) });
      push({ ...(items ? { history: { ...h, items } } : {}),
        toSign: (state.toSign || []).filter(x => !(x.repo === t.repo && x.number === t.number)),
        toSignReleases: (state.toSignReleases || []).map(rel => ({ ...rel, repos: rel.repos.map(x => x.number === t.number && x.label === t.label ? { ...x, mine: true, older: false } : x) })) });
    };
    await Promise.all([...targets.values()].map(async (t) => {
      const s = await signoffOf(t.repo, t.number);
      if (s.error) return failed.push(`${t.label} #${t.number}: ${s.error}`);
      if (hasSigned(s, who.github)) return signed(t);
      if (s.pr.user.login.toLowerCase() === who.github.toLowerCase()) { // mine: re-stamp my opener line on the new head
        if (!(await stampOpener(t.repo, t.number, who))) return failed.push(`${t.label}: couldn't update my signature line`);
        return signed(t);
      }
      const res = await ghJson(['api', '-X', 'POST', `repos/${t.repo}/pulls/${t.number}/reviews`, '--input',
        writeTmp({ event: 'APPROVE', commit_id: s.pr.head.sha, body: reviewMark(who.clickup) })]);
      if (apiErr(res)) return failed.push(`${t.label}: ${apiErr(res)}`);
      signed(t);
      const i = run ? run.rows.findIndex(r => r.repo === t.repo && r.pr && r.pr.number === t.number) : -1;
      if (i >= 0) {
        const r = run.rows[i], so = r.signoff || { signers: [], need: 2 };
        const signers = so.signers.some(x => x.login.toLowerCase() === who.github.toLowerCase()) ? so.signers : so.signers.concat({ login: who.github, via: 'approved', clickup: who.clickup });
        run.rows[i] = { ...r, signoff: { ...so, signers, count: signers.length, ok: signers.length >= so.need } };
      }
    }));
    // show it right away (my run, my to-sign list), then write it to the manifest: that commit is what
    // the teammates' Overlords see within SIGN_PING_MS
    const key = (t) => t.repo + '#' + t.number;
    const signedKeys = new Set(done.map(key));
    push({ toSign: (state.toSign || []).filter(t => !signedKeys.has(key(t))), ...(run ? { releaseRun: { ...stampSignoff(run) } } : {}) });
    persist();
    send({ type: 'toast', text: failed.length ? `Sign failed: ${failed.join('; ')}` : done.length ? 'Signed the release ✍' : 'Nothing left for you to sign' });
    await reconcileHistory().catch(() => {});
    checkToSign().catch(() => {});
  }

  // Release history: manifests in <org>/release-manifests (release-history.js)
  const requestReviews = async (repo, n) => {
    const who = await whoAmI();
    const others = memberLogins().filter(m => m.toLowerCase() !== String(who.github).toLowerCase());
    if (others.length) await ghJson(['api', '-X', 'POST', `repos/${repo}/pulls/${n}/requested_reviewers`, '--input', writeTmp({ reviewers: others })]);
  };
  const history = createHistory({ ghJson, writeTmp: (p) => writeTmp(p), push, getState: () => state, org: () => approversOrg(),
    signoffOf, requestReviews, whoAmI, send });
  // one at a time; a call during a run queues exactly one more (a sign mid-reconcile must still land)
  let reconciling = null, again = false;
  const reconcileHistory = async () => {
    if (reconciling) { again = true; return reconciling; }
    reconciling = (async () => { try { do { again = false; await history.reconcile(); } while (again); } finally { reconciling = null; } })();
    return reconciling;
  };

  // ── Release all: merge in the config's releaseOrder waves (services the others depend on
  // first, the frontend last); after each wave, wait for its CI deploys to go green before the
  // next; stop on a failed deploy so nothing ships on top of a broken service. Sources: the
  // last run here (any env) and/or a pending release from the history.
  const DEPLOY_WAIT_MS = 30 * 60 * 1000, DEPLOY_POLL_MS = 20 * 1000;
  let releaseAllStop = false;
  const progress = (p) => { push({ releaseAll: p ? { ...(state.releaseAll || {}), ...p, at: Date.now() } : null }); persist(); shareRun(); };
  // The team sees one Release all at a time: running.json in release-manifests says who runs it and
  // how far it got (written on each step, plus a heartbeat); nobody else can start one while it's fresh.
  const LOCK_STALE_MS = 10 * 60 * 1000, BEAT_MS = 4 * 60 * 1000;
  let shareTimer = null, beatTimer = null;
  function shareRun() {
    clearTimeout(shareTimer);
    shareTimer = setTimeout(async () => {
      const p = state.releaseAll, who = await whoAmI();
      if (p && p.running) await history.setRunning({ running: true, by: who.github, beat: new Date().toISOString(), id: p.id || null,
        wave: p.wave, waves: p.waves, status: p.status, detail: p.detail || '', merged: p.merged || [] }).catch(() => {});
    }, 1500);
  }
  const fresh = (r) => r && r.running !== false && Date.now() - Date.parse(r.beat) < LOCK_STALE_MS;
  // a teammate's Release all: live while it runs; when it ends, one notification with how it went
  let lastTeamEnd = undefined;
  async function loadTeamRun() {
    const r = await history.running().catch(() => null);
    const who = await whoAmI();
    const other = r && String(r.by).toLowerCase() !== String(who.github).toLowerCase();
    push({ teamRun: fresh(r) && other ? r : null });
    const end = r && r.running === false ? r.endedAt : null;
    if (lastTeamEnd !== undefined && end && end !== lastTeamEnd && other && notify) {
      notify(r.status === 'done' ? `🚀 @${r.by} released: every wave merged` : `⏸ @${r.by}'s Release all stopped`, r.detail || '', null,
        () => send({ type: 'releases', state, open: true }));
    }
    lastTeamEnd = end; // the first read only learns where things stand (no notification on startup)
  }
  // after a deploy that merged minutes ago (Release all resumed mid deploy-wait): same wait as a wave's
  async function waitDeploys(list) {
    const until = Date.now() + DEPLOY_WAIT_MS;
    let pending = list;
    while (pending.length) {
      if (releaseAllStop) return { detail: 'Stopped by you' };
      if (Date.now() > until) return { detail: `Deploys still running after 30 min: ${pending.map(x => x.label).join(', ')}` };
      await new Promise(r => setTimeout(r, DEPLOY_POLL_MS));
      const still = [];
      for (const x of pending) {
        const runs = await ghJson(['api', '-X', 'GET', `repos/${x.repo}/actions/workflows/${x.deploy}/runs`, '-f', `head_sha=${x.sha}`, '-f', 'per_page=5']);
        const done = ((runs.data && runs.data.workflow_runs) || []).find(r => r.status === 'completed');
        if (!done) { still.push(x); continue; }
        if (done.conclusion !== 'success') {
          if (notify) notify(`❌ Release stopped · ${x.label} deploy failed`, 'Later waves were not merged', done.html_url);
          return { detail: `${x.label} deploy failed — later waves not merged`, url: done.html_url };
        }
      }
      pending = still;
    }
    return null;
  }

  function releaseItems(id) {
    if (id) {
      const m = ((state.history && state.history.items) || []).find(x => x.id === id);
      return m ? m.repos.filter(r => !r.mergeSha && !r.closed).map(r => ({ repo: r.repo, label: r.label, env: 'prod', source: r.source, target: r.target,
        pr: r.pr, deploy: r.deploy && r.deploy.workflow })) : [];
    }
    return ((state.releaseRun && state.releaseRun.rows) || []).filter(r => r.pr && !r.merged && !r.closed)
      .map(r => ({ repo: r.repo, label: r.label, env: r.env, source: r.source, target: r.target, pr: r.pr, deploy: r.deploy }));
  }

  // A hand-deployed wave: show where to deploy each (state.releaseAll.manualWave) and wait until every
  // one is live — checked through its `live` pin each poll — or someone presses "Deployed, continue".
  // Returns null to go on, or why it stopped.
  let manualDone = false;
  // "Deployed": record each branch's head as what's live now, so the next release only asks when
  // there's something new (fetchLives reads it back). Trusts the person: nothing verifies the deploy.
  async function confirmDeployed(items) {
    const who = await whoAmI();
    const heads = await Promise.all(items.map(async (x) => {
      const r = await ghJson(['api', `repos/${x.repo}/commits/${x.branch}`]);
      return r.data && r.data.sha ? { repo: x.repo, env: x.env, sha: r.data.sha } : null;
    }));
    const ok = heads.filter(Boolean);
    if (ok.length) await history.confirm(ok, who.github, state.releaseAll && state.releaseAll.id).catch(e => send({ type: 'toast', text: 'Confirm deploy: ' + e.message }));
    if (ok.length < items.length) send({ type: 'toast', text: `Couldn't read the branch of ${items.filter((x, i) => !heads[i]).map(x => x.label).join(', ')}: not recorded` });
    const lives = await fetchLives(state.config).catch(() => null);
    if (lives) push({ results: { ...(state.results || {}), lives }, grid: buildGrid(state.config, { ...(state.results || {}), lives }) });
  }
  async function waitManual(hand) {
    manualDone = false;
    for (;;) {
      if (releaseAllStop) return 'Stopped by you';
      const lives = await fetchLives(state.config).catch(() => null);
      if (lives) push({ results: { ...(state.results || {}), lives } });
      const left = manualLeft(state.config, [], hand, lives || (state.results && state.results.lives));
      if (manualDone) await confirmDeployed(left);
      if (!left.length || manualDone) { progress({ manualWave: null }); return null; }
      progress({ status: 'manual', detail: left.map(x => x.label).join(', '), manualWave: left.map(x => {
        const l = lives && lives[`${x.repo}|${x.env}`];
        return { ...x, auto: !!(l && !l.error) };
      }) });
      await new Promise(r => setTimeout(r, DEPLOY_POLL_MS));
    }
  }

  // Call a release off: close every still-open PR of it (the History release `id`, else the last run
  // here), each with a note. What already merged stays merged. The release then reads as abandoned.
  async function cancelRelease(id) {
    await loadApprovers();
    if (!state.approvers.isApprover) return send({ type: 'toast', text: 'Only release approvers can cancel a release' });
    if (state.releaseAll && state.releaseAll.running) return send({ type: 'toast', text: 'Release all is running: stop it first' });
    const who = await whoAmI();
    const items = releaseItems(id || null);
    if (!items.length) return send({ type: 'toast', text: 'Nothing open to cancel' });
    const note = `Release${id ? ' ' + id : ''} called off by @${who.github} in Overlord: closing without merging.`;
    const failed = [];
    await Promise.all(items.map(async (it) => {
      const r = await ghJson(['api', '-X', 'PATCH', `repos/${it.repo}/pulls/${it.pr.number}`, '--input', writeTmp({ state: 'closed' })]);
      if (apiErr(r)) return failed.push(`${it.label} #${it.pr.number}: ${apiErr(r)}`);
      await ghJson(['api', '-X', 'POST', `repos/${it.repo}/issues/${it.pr.number}/comments`, '--input', writeTmp({ body: note })]);
    }));
    const run = state.releaseRun;
    if (run) {
      const shut = new Set(items.map(it => it.repo + '#' + it.pr.number));
      for (const r of run.rows) if (r.pr && shut.has(r.repo + '#' + r.pr.number) && !failed.some(f => f.startsWith(r.label + ' '))) r.closed = true;
      push({ releaseRun: { ...stampSignoff(run) } });
    }
    send({ type: 'toast', text: failed.length ? `Cancel: couldn't close ${failed.join('; ')}` : `Release cancelled: ${items.length} PR${items.length === 1 ? '' : 's'} closed` });
    await refreshRun().catch(() => {});
    reconcileHistory().catch(() => {});
    checkToSign().catch(() => {});
  }

  async function releaseAll(id) {
    if (state.releaseAll && state.releaseAll.running) return send({ type: 'toast', text: 'Release all is already running' });
    if (!versionOk()) return send({ type: 'toast', text: outdatedMsg() });
    const lock = await history.running().catch(() => null), me = (await whoAmI()).github;
    if (fresh(lock) && String(lock.by).toLowerCase() !== String(me).toLowerCase()) {
      return send({ type: 'toast', text: `Release all is running on @${lock.by}'s Overlord (wave ${lock.wave}/${lock.waves}) — one at a time` });
    }
    // what's really still open (a resume, or PRs merged elsewhere): merged ones drop out, and one that
    // merged in the last hour gets its deploy waited on before anything else merges
    const listed = releaseItems(id);
    const live = await Promise.all(listed.map(it => ghJson(['api', `repos/${it.repo}/pulls/${it.pr.number}`])));
    const items = [], justMerged = [];
    listed.forEach((it, i) => {
      const p = live[i].data;
      if (p && p.merged) { if (Date.now() - Date.parse(p.merged_at) < 3600e3 && it.deploy && it.deploy !== 'manual') justMerged.push({ ...it, sha: p.merge_commit_sha }); }
      else if (!(p && p.state === 'closed')) items.push(it);
    });
    if (!items.length) return send({ type: 'toast', text: 'Nothing open to release' });
    // an open back-merge must go first — and merging it changes the release PR, so re-sign after
    const backs = [];
    await Promise.all(items.map(async (it) => {
      const r = await ghJson(['api', '-X', 'GET', `repos/${it.repo}/pulls`, '-f', 'state=open', '-f', `base=${it.source}`, '-f', 'per_page=100']);
      if ((Array.isArray(r.data) ? r.data : []).some(p => p.head && p.head.ref === it.target)) backs.push(it.label);
    }));
    if (backs.length) return send({ type: 'toast', text: `Merge the back-merge PR first (${backs.join(', ')}), then Release all` });
    // set aside what can't merge yet (prod without its 2 signatures): merge the rest, report the skipped
    const skipped = [], go = [];
    for (const it of items) {
      const gate = await mergeGate(it.pr.url);
      (gate.ok ? go : skipped).push(gate.ok ? it : { ...it, why: gate.reason });
    }
    if (!go.length) return send({ type: 'toast', text: `Nothing can merge yet: ${skipped.map(x => `${x.label} ${x.env} — ${x.why}`).join('; ')}` });
    const skippedNote = skipped.length ? ` · not merged (waiting): ${skipped.map(x => x.label + ' ' + x.env).join(', ')}` : '';
    // hand-deployed repos named in releaseOrder are waves too: Release all pauses there until they're live
    // (seen through their `live` pin) or someone says they're deployed; the rest go in the end popup
    const man = (id ? (((state.history && state.history.items) || []).find(x => x.id === id) || {}).manual || [] : (state.releaseRun && state.releaseRun.manual) || [])
      .map(m => ({ env: 'prod', ...m, manual: true }));
    const inOrder = (m) => (state.config.releaseOrder || []).some(w => w.some(x => x === m.label || x.toLowerCase() === m.repo.toLowerCase()));
    const handWaves = man.filter(inOrder), handLater = man.filter(m => !inOrder(m));
    const waves = releaseWaves(state.config, go.concat(handWaves));
    releaseAllStop = false; manualDone = false;
    const shipped = [];
    progress({ running: true, id: id || null, wave: 0, waves: waves.length, merged: [], status: 'merging', detail: '', url: null });
    clearInterval(beatTimer); beatTimer = setInterval(shareRun, BEAT_MS);
    try {
      if (justMerged.length) {
        progress({ status: 'deploying', detail: justMerged.map(x => x.label).join(', ') });
        const bad = await waitDeploys(justMerged);
        if (bad) return progress({ running: false, status: 'stopped', ...bad });
      }
      for (let w = 0; w < waves.length; w++) {
        if (releaseAllStop) return progress({ running: false, status: 'stopped', detail: 'Stopped by you' });
        const wave = waves[w];
        progress({ wave: w + 1, status: 'merging', detail: wave.map(x => x.label + (x.env !== 'prod' ? ' ' + x.env : '')).join(', ') });
        const merged = [];
        const hand = wave.filter(x => x.manual);
        if (hand.length) {
          const r = await waitManual(hand);
          if (r) return progress({ running: false, status: 'stopped', detail: r, manualWave: null });
        }
        for (const it of wave.filter(x => !x.manual)) {
          if (releaseAllStop) return progress({ running: false, status: 'stopped', detail: 'Stopped by you' });
          const gate = await mergeGate(it.pr.url);
          if (!gate.ok) return progress({ running: false, status: 'stopped', detail: `${it.label}: ${gate.reason}` });
          const res = await ghJson(['api', '-X', 'PUT', `repos/${it.repo}/pulls/${it.pr.number}/merge`, '-f', 'merge_method=merge']);
          if (apiErr(res)) return progress({ running: false, status: 'stopped', detail: `Merge ${it.label}: ${apiErr(res)}` });
          merged.push({ ...it, sha: res.data && res.data.sha });
          shipped.push(it);
          progress({ merged: (state.releaseAll.merged || []).concat(it.label + (it.env !== 'prod' ? ' ' + it.env : '')) });
        }
        // wait for this wave's CI deploys (repos deployed by hand can't be waited on)
        const waitOn = merged.filter(x => x.deploy && x.deploy !== 'manual' && x.sha);
        if (!waitOn.length || w === waves.length - 1) continue; // the last wave needn't hold anything back
        progress({ status: 'deploying', detail: waitOn.map(x => x.label).join(', ') });
        const bad = await waitDeploys(waitOn);
        if (bad) return progress({ running: false, status: 'stopped', ...bad });
      }
      // what's still on people: hand-deployed repos behind, and merged PRs whose target has no CI deploy
      const left = manualLeft(state.config, shipped, handLater, state.results && state.results.lives);
      progress({ running: false, status: 'done', detail: 'Every wave merged' + skippedNote, manualLeft: left, doneAt: Date.now() });
      send({ type: 'toast', text: 'Release all: every wave merged ✓' + skippedNote });
    } finally {
      if (state.releaseAll && state.releaseAll.running) progress({ running: false });
      clearInterval(beatTimer); clearTimeout(shareTimer);
      whoAmI().then(who => { const p = state.releaseAll || {};
        return history.setRunning({ running: false, by: who.github, beat: new Date().toISOString(), endedAt: new Date().toISOString(), id: p.id || null,
          wave: p.wave, waves: p.waves, status: p.status, detail: p.detail || '', merged: p.merged || [] }); }).catch(() => {});
      reconcileHistory().catch(() => {});
      refresh();
    }
  }

  // Oldest Overlord allowed to release/sign/merge (config minOverlord): older builds miss rules.
  const APP_VERSION = require('./package.json').version;
  const versionOk = () => versionAtLeast(APP_VERSION, state.config && state.config.minOverlord);
  const outdatedMsg = () => `Update Overlord to ${state.config.minOverlord} or later to release (this is ${APP_VERSION})`;

  const writeTmp = (payload) => { const p = path.join(runsDir(), `api-${stamp()}-${Math.random().toString(36).slice(2, 7)}.json`); fs.writeFileSync(p, JSON.stringify(payload)); return p; };

  // The config repo's local checkout (where the frontend's flag-gap check and a Fix agent work),
  // else the home dir.
  async function configCheckout() {
    // the config names the app repo whose clone runs the flag check and the Fix agents
    const home = state.config && state.config.checkout;
    if (home && findLocal) {
      const l = await findLocal(home, 'package.json', '');
      if (l) return path.dirname(l.path);
    }
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
    if (!versionOk()) { send({ type: 'toast', text: outdatedMsg() }); return; }
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
    await Promise.all(run.rows.filter(r => r.env === 'prod' && r.pr && !r.merged && !r.closed).map(r => stampOpener(r.repo, r.pr.number, who)));
    run.running = false;
    for (const r of run.rows) delete r.body; // only needed for that patch
    push({ releaseRun: { ...stampSignoff(run) } });
    persist();
    recheck(run);
    // the shared record: this release's manifest in <org>/release-manifests
    const lives = (state.results && state.results.lives) || {};
    shareHealth(run);
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
  // re-read these [row, index] pairs of a run (state, checks, sign-off) and publish
  async function recheckRows(cur, pairs) {
    await Promise.all(pairs.map(async ([r, i]) => {
      const h = await prHealth(ghJson, r.repo, r.pr.number, r.target, undefined, r.env === 'prod' ? memberLogins() : null);
      const row = { ...r, ...h };
      row.status = rowStatus(row);
      cur.rows[i] = row;
    }));
    push({ releaseRun: { ...stampSignoff(cur), checkedAt: Date.now() } });
    persist();
    shareHealth(cur);
  }
  // what the run found per prod PR (checks, conflicts, back-merges, dbschemas) goes into the release
  // record, so teammates see it in History, not just the machine that clicked Release
  let healthTimer = null;
  function shareHealth(run) {
    clearTimeout(healthTimer);
    healthTimer = setTimeout(() => history.recordHealth(run.rows).catch(() => {}), 3000);
  }
  // opening Releases: the last run's rows can be hours old (PRs closed/merged/re-signed on GitHub since)
  async function refreshRun() {
    const cur = state.releaseRun;
    if (!cur || cur.running) return;
    const open = cur.rows.map((r, i) => [r, i]).filter(([r]) => r.pr && !r.merged && !r.closed);
    if (open.length) await recheckRows(cur, open);
    const prs = state.releaseRun && state.releaseRun.rows.filter(r => r.pr);
    if (prs && prs.length && prs.every(r => r.closed && !r.merged)) { push({ releaseRun: null }); persist(); } // called off
  }
  function recheck(run) {
    clearTimeout(recheckTimer);
    const unsigned = (r) => { const s = (state.releaseRun || run).signoff; return r.env === 'prod' && s && !s.ok; };
    const settled = (r) => !r.pr || r.merged || r.closed || (r.checks !== 'pending' && r.checks !== 'none' && r.conflict !== null && !unsigned(r));
    const tick = async () => {
      if (state.releaseRun !== run && (!state.releaseRun || state.releaseRun.startedAt !== run.startedAt)) return;
      const cur = state.releaseRun;
      const open = cur.rows.map((r, i) => [r, i]).filter(([r]) => !settled(r));
      const signing = cur.rows.some(r => !r.merged && !r.closed && unsigned(r));
      if (!open.length || Date.now() - cur.startedAt > (signing ? SIGN_WATCH_MS : RECHECK_FOR_MS)) return;
      await recheckRows(cur, open);
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
  // i = one row (its own Fix button); none = every blocked row (Fix all)
  async function fixAll(i) {
    const all = (state.releaseRun && state.releaseRun.rows) || [];
    const rows = (Number.isInteger(i) ? [all[i]] : all).filter(r => r && (r.status === 'blocked' || r.status === 'error'));
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
        loadApprovers().then(refreshRun).catch(() => {});
        loadTeamRun().catch(() => {});
        // reopened within a minute: what's on screen is fresh enough, the timer takes it from here
        if (!state.updatedAt || Date.now() - state.updatedAt > 60000) refresh();
        return true;
      case 'releasesClose': return true;
      case 'releasesRefresh': refresh(); return true;
      case 'releasesRelease': release(msg.envs).catch(e => { if (state.releaseRun) push({ releaseRun: { ...state.releaseRun, running: false } }); send({ type: 'toast', text: 'Release failed: ' + (e.message || 'error') }); }); return true;
      case 'releasesFix': fixAll(msg.i).catch(e => send({ type: 'toast', text: 'Fix failed: ' + (e.message || 'error') })); return true;
      case 'releasesApprovers': loadApprovers().catch(() => {}); return true;
      case 'releasesApproversEdit': approversEdit(msg.kind, msg.login).catch(e => send({ type: 'toast', text: 'Approvers: ' + e.message })); return true;
      case 'releasesSign': signRelease().catch(e => send({ type: 'toast', text: 'Sign failed: ' + (e.message || 'error') })); return true;
      case 'releasesMerge': releaseAll(null).catch(e => send({ type: 'toast', text: 'Release all failed: ' + (e.message || 'error') })); return true;
      case 'releasesReleaseAllStop': releaseAllStop = true; return true;
      case 'releasesManualDone': manualDone = true; return true;
      case 'releasesManualConfirm': { // the end popup's "Deployed"
        const left = (state.releaseAll && state.releaseAll.manualLeft) || [];
        confirmDeployed(left).then(() => progress({ manualLeft: [] })).catch(e => send({ type: 'toast', text: 'Confirm deploy: ' + e.message }));
        return true;
      }
      case 'releasesFixDeploy': { // Fix on a failed deploy cell: same agent as the Actions list's Fix
        const d = state.results && state.results.deploys && state.results.deploys[msg.key];
        if (d && fixRun) fixRun(d).catch(e => send({ type: 'toast', text: 'Fix failed: ' + (e.message || 'error') }));
        return true;
      }
      case 'releasesHistory': history.load().then(() => reconcileHistory()).catch(e => push({ history: { error: e.message, items: [] } })); return true;
      case 'releasesRollback': history.rollback(msg.id, msg.skip || []).catch(e => send({ type: 'toast', text: 'Rollback failed: ' + e.message })); return true;
      case 'releasesImport': history.importPast(state.config ? releasePlan(state.config, ['prod']).prs : []).then(() => reconcileHistory()).catch(e => send({ type: 'toast', text: 'Import failed: ' + e.message })); return true;
      case 'releasesMergeRelease': releaseAll(msg.id).catch(e => send({ type: 'toast', text: 'Release all failed: ' + e.message })); return true;
      case 'releasesCancel': cancelRelease(msg.id).catch(e => send({ type: 'toast', text: 'Cancel failed: ' + e.message })); return true;
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
