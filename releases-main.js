// Main-process side of the Releases board. Owns its own state file so removing
// the feature is deleting the releases-* files plus two hook lines in main.js.
// Renderer contract: receives releasesOpen / releasesClose / releasesRefresh /
// releasesSetSource, sends { type: 'releases', state }.

const fs = require('fs');
const path = require('path');
const { releaseFixBrief } = require('./release-playbook');
const { runRelease, prHealth, rowStatus } = require('./release-run');
const { execFile } = require('child_process');
const os = require('os');
const { releaseTargets, releasePlan } = require('./releases-core');
const { parseSource, validateConfig, requestsFor, buildGrid, commitTitle, firstParentChain, runState, liveSha, SAFE_REF_RE, DEFAULT_SOURCE } = require('./releases-core');

const REFRESH_MS = 5 * 60 * 1000;
const RUN_TTL_MS = 24 * 3600 * 1000;   // release results older than this are dropped on load
const RECHECK_MS = 60 * 1000;           // re-read release PRs' checks this often…
const RECHECK_FOR_MS = 30 * 60 * 1000;  // …for this long after a run, until they settle
const PENDING_SHOWN = 10;
const HISTORY_SHOWN = 10;
const RUNS_SHOWN = 15; // deploy runs per env for the Timeline — same call as the latest-run check
const HISTORY_SCAN = 40; // enough raw history to walk HISTORY_SHOWN first-parent steps

module.exports = function createReleases({ send, ghJson, ghGraphql, stateDir, findLocal, startAgent }) {
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
  async function fetchDeploys(cfg) {
    const out = {};
    await Promise.all(requestsFor(cfg).deploys.map(async (d) => {
      const res = await ghJson(['api', '-X', 'GET', `repos/${d.repo}/actions/workflows/${d.file}/runs`, '-f', `branch=${d.branch}`, '-f', `per_page=${RUNS_SHOWN}`]);
      const all = (res.data && res.data.workflow_runs) || [], run = all[0];
      // finished runs for the Timeline: when each deploy went out, who ran it, did it work
      const runs = all.filter(x => x.status === 'completed' && x.conclusion !== 'cancelled' && x.conclusion !== 'skipped').map(x => ({
        sha: x.head_sha, date: x.updated_at, state: x.conclusion, url: x.html_url, actor: (x.actor && x.actor.login) || '',
        title: commitTitle(String((x.head_commit && x.head_commit.message) || x.display_title || '').split('\n')[0], String((x.head_commit && x.head_commit.message) || '').split('\n').slice(2).join('\n')),
      }));
      const key = `${d.repo}|${d.env}`;
      if (res.error) { out[key] = { state: 'unknown', error: res.error }; return; }
      if (!run) { out[key] = { state: 'never', url: `https://github.com/${d.repo}/actions/workflows/${d.file}` }; return; }
      const base = { url: run.html_url, date: run.updated_at || run.created_at, runs };
      if (run.status !== 'completed') { out[key] = { ...base, state: 'running' }; return; }
      // Red run: one more call to learn WHICH job failed — the deploy, or a follow-up after it
      // plus whether it has EVER gone green here: one that never has isn't what deploys this env
      let failed = [], everSucceeded;
      if (run.conclusion === 'failure') {
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
      const [listed, deploys, lives] = await Promise.all([fetchResults(cfg, true), fetchDeploys(cfg), fetchLives(cfg)]);
      if (state.config !== cfg) return;
      const results = { commits: state.results.commits, compares: listed.error ? state.results.compares : listed.results.compares,
        history: listed.error ? state.results.history : listed.results.history, deploys, lives };
      push({ results, grid: buildGrid(cfg, results) });
    } finally {
      inFlight = false;
      push({ loading: false });
      persist();
    }
  }

  // Polls even while the modal is closed: the footer badge says when a deploy is failing.
  // Starts late so it stays out of the app's startup rush.
  setTimeout(() => {
    refresh(); timer = setInterval(refresh, REFRESH_MS); timer.unref?.();
    // Overlord restarted while a recent run was still settling: keep watching its PRs
    const r = state.releaseRun;
    if (r && !r.running && Date.now() - r.startedAt < RECHECK_FOR_MS) recheck(r);
  }, 20000).unref?.(); // unref: never the reason a process stays alive

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
    const plan = releasePlan(cfg, envs);
    const run = { envs, startedAt: Date.now(), running: true, rows: plan.prs.map(p => ({ ...p, running: true })), manual: plan.manual, flags: null };
    push({ releaseRun: run });
    const cwd = await configCheckout();
    const flagScript = path.join(cwd, '.claude', 'skills', 'release', 'flag-gap.cjs');
    const flags = envs.includes('prod') && fs.existsSync(flagScript) ? flagGap(cwd, flagScript) : Promise.resolve(null);
    let n = 0;
    const writeJson = (payload) => { const p = path.join(runsDir(), `pr-${stamp()}-${n++}.json`); fs.writeFileSync(p, JSON.stringify(payload)); return p; };
    const onRow = (i, row) => { run.rows[i] = { ...row }; push({ releaseRun: { ...run } }); };
    await runRelease(ghJson, plan.prs, { writeJson, onRow });
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
    run.running = false;
    for (const r of run.rows) delete r.body; // only needed for that patch
    push({ releaseRun: { ...run } });
    persist();
    recheck(run);
    const blocked = run.rows.filter(r => r.status === 'blocked' || r.status === 'error').length;
    const opened = run.rows.filter(r => r.pr && !r.reused).length;
    send({ type: 'toast', text: `Release ${envs.join(' + ')}: ${opened} PR${opened === 1 ? '' : 's'} opened${blocked ? `, ${blocked} blocked` : ''}` });
  }

  // After a run: a fresh PR's own checks only start once it exists, so re-read every open row
  // each minute until nothing is pending or unknown (or half an hour passes, or a new run starts).
  let recheckTimer = null;
  function recheck(run) {
    clearTimeout(recheckTimer);
    const settled = (r) => !r.pr || r.merged || r.closed || (r.checks !== 'pending' && r.checks !== 'none' && r.conflict !== null);
    const tick = async () => {
      if (state.releaseRun !== run && (!state.releaseRun || state.releaseRun.startedAt !== run.startedAt)) return;
      const cur = state.releaseRun;
      const open = cur.rows.map((r, i) => [r, i]).filter(([r]) => !settled(r));
      if (!open.length || Date.now() - cur.startedAt > RECHECK_FOR_MS) return;
      await Promise.all(open.map(async ([r, i]) => {
        const h = await prHealth(ghJson, r.repo, r.pr.number, r.target);
        const row = { ...r, ...h };
        row.status = rowStatus(row);
        cur.rows[i] = row;
      }));
      push({ releaseRun: { ...cur, checkedAt: Date.now() } });
      persist();
      recheckTimer = setTimeout(tick, RECHECK_MS);
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
        // reopened within a minute: what's on screen is fresh enough, the timer takes it from here
        if (!state.updatedAt || Date.now() - state.updatedAt > 60000) refresh();
        return true;
      case 'releasesClose': return true;
      case 'releasesRefresh': refresh(); return true;
      case 'releasesRelease': release(msg.envs).catch(e => { if (state.releaseRun) push({ releaseRun: { ...state.releaseRun, running: false } }); send({ type: 'toast', text: 'Release failed: ' + (e.message || 'error') }); }); return true;
      case 'releasesFix': fixAll().catch(e => send({ type: 'toast', text: 'Fix failed: ' + (e.message || 'error') })); return true;
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

  return { handle };
};
