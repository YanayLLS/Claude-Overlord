// Main-process side of the Releases board. Owns its own state file so removing
// the feature is deleting the releases-* files plus two hook lines in main.js.
// Renderer contract: receives releasesOpen / releasesClose / releasesRefresh /
// releasesSetSource, sends { type: 'releases', state }.

const fs = require('fs');
const path = require('path');
const { parseSource, validateConfig, requestsFor, buildGrid, commitTitle, runState, DEFAULT_SOURCE } = require('./releases-core');

const REFRESH_MS = 5 * 60 * 1000;
const PENDING_SHOWN = 10;

module.exports = function createReleases({ send, ghJson, ghGraphql, stateDir, findLocal }) {
  const file = path.join(stateDir, 'releases.json');
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf-8')) || {}; } catch {}
  let state = { source: saved.source || DEFAULT_SOURCE, ...(saved.cache || {}), loading: false };
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
      const res = await ghJson(['api', `repos/${src.repo}/contents/${src.path}${src.ref ? `?ref=${src.ref}` : ''}`]);
      if (res.error) return { error: res.error, errorCode: res.errorCode || null };
      if (!res.data || typeof res.data.content !== 'string') {
        // Not on GitHub yet: read it from a local clone so the board works before it's pushed.
        const local = findLocal && await findLocal(src.repo, src.path);
        if (local) {
          try { return { config: JSON.parse(fs.readFileSync(local, 'utf-8')), localOnly: local }; }
          catch (e) { return { error: `Config at ${local} is not valid JSON: ${e.message}` }; }
        }
        return { error: `No config at ${source}${res.data && res.data.message ? ` (${res.data.message})` : ''} — no access, or the file isn't there yet.` };
      }
      text = Buffer.from(res.data.content, 'base64').toString('utf-8');
    }
    try { return { config: JSON.parse(text) }; } catch (e) { return { error: `Config is not valid JSON: ${e.message}` }; }
  }

  // Every branch tip and every promote count in one GraphQL call. A missing
  // branch comes back as a null ref, not an error, so one bad row can't sink the rest.
  // lists=true is the slower second pass: only the waiting commits behind each count,
  // which nobody sees until they click a cell.
  async function fetchResults(cfg, lists = false) {
    const { commits, compares } = requestsFor(cfg);
    const repos = [...new Set([...(lists ? [] : commits), ...compares].map(x => x.repo))];
    if (!repos.length) return { results: { commits: {}, compares: {} } };
    const q = JSON.stringify;
    const parts = repos.map((repo, i) => {
      const [owner, name] = repo.split('/');
      const tips = lists ? [] : commits.filter(c => c.repo === repo).map((c, j) =>
        `t${j}: ref(qualifiedName: ${q('refs/heads/' + c.branch)}) { target { ... on Commit { oid messageHeadline messageBody committedDate url author { name user { login } } } } }`);
      const cmps = compares.filter(c => c.repo === repo).map((c, j) =>
        `c${j}: ref(qualifiedName: ${q('refs/heads/' + c.base)}) { compare(headRef: ${q(c.head)}) { aheadBy${lists ? ` commits(last: ${PENDING_SHOWN}) { nodes { oid messageHeadline messageBody url } }` : ''} } }`);
      return `r${i}: repository(owner: ${q(owner)}, name: ${q(name)}) { ${[...tips, ...cmps].join(' ')} }`;
    });
    const res = await ghGraphql(`query { ${parts.join(' ')} }`);
    const out = { commits: {}, compares: {} };
    if (res.error) return { error: res.error, errorCode: res.errorCode || null };
    repos.forEach((repo, i) => {
      const node = res.data[`r${i}`];
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
        const key = `${repo}|${c.from}`;
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
      const res = await ghJson(['api', '-X', 'GET', `repos/${d.repo}/actions/workflows/${d.file}/runs`, '-f', `branch=${d.branch}`, '-f', 'per_page=1']);
      const run = res.data && res.data.workflow_runs && res.data.workflow_runs[0];
      const key = `${d.repo}|${d.env}`;
      if (res.error) { out[key] = { state: 'unknown', error: res.error }; return; }
      if (!run) { out[key] = { state: 'never', url: `https://github.com/${d.repo}/actions/workflows/${d.file}` }; return; }
      const base = { url: run.html_url, date: run.updated_at || run.created_at };
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
      for (const [k, v] of Object.entries(fetched.results.compares)) if (prev[k] && prev[k].ahead === v.ahead) v.commits = prev[k].commits;
      push({ error: null, errorCode: null, problems: null, localOnly: loaded.localOnly || null, config: cfg, results: fetched.results,
        grid: buildGrid(cfg, fetched.results), updatedAt: Date.now() });
      const [listed, deploys] = await Promise.all([fetchResults(cfg, true), fetchDeploys(cfg)]);
      if (state.config !== cfg) return;
      const results = { commits: state.results.commits, compares: listed.error ? state.results.compares : listed.results.compares, deploys };
      push({ results, grid: buildGrid(cfg, results) });
    } finally {
      inFlight = false;
      push({ loading: false });
      persist();
    }
  }

  // Polls even while the modal is closed: the footer badge says when a deploy is failing.
  // Starts late so it stays out of the app's startup rush.
  setTimeout(() => { refresh(); timer = setInterval(refresh, REFRESH_MS); timer.unref?.(); }, 20000).unref?.(); // unref: never the reason a process stays alive

  function handle(msg) {
    switch (msg && msg.type) {
      case 'releasesOpen':
        send({ type: 'releases', state });
        // reopened within a minute: what's on screen is fresh enough, the timer takes it from here
        if (!state.updatedAt || Date.now() - state.updatedAt > 60000) refresh();
        return true;
      case 'releasesClose': return true;
      case 'releasesRefresh': refresh(); return true;
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
