// Main-process side of the Releases board. Owns its own state file so removing
// the feature is deleting the releases-* files plus two hook lines in main.js.
// Renderer contract: receives releasesOpen / releasesClose / releasesRefresh /
// releasesSetSource, sends { type: 'releases', state }.

const fs = require('fs');
const path = require('path');
const { parseSource, validateConfig, requestsFor, buildGrid, commitTitle, DEFAULT_SOURCE } = require('./releases-core');

const REFRESH_MS = 5 * 60 * 1000;
const PENDING_SHOWN = 10;

module.exports = function createReleases({ send, ghJson, ghGraphql, stateDir }) {
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
        return { error: `No config at ${source}${res.data && res.data.message ? ` (${res.data.message})` : ''} — no access, or the file isn't there yet.` };
      }
      text = Buffer.from(res.data.content, 'base64').toString('utf-8');
    }
    try { return { config: JSON.parse(text) }; } catch (e) { return { error: `Config is not valid JSON: ${e.message}` }; }
  }

  // Every branch tip and every promote compare in one GraphQL call. A missing
  // branch comes back as a null ref, not an error, so one bad row can't sink the rest.
  async function fetchResults(cfg) {
    const { commits, compares } = requestsFor(cfg);
    const repos = [...new Set([...commits, ...compares].map(x => x.repo))];
    const q = JSON.stringify;
    const parts = repos.map((repo, i) => {
      const [owner, name] = repo.split('/');
      const tips = commits.filter(c => c.repo === repo).map((c, j) =>
        `t${j}: ref(qualifiedName: ${q('refs/heads/' + c.branch)}) { target { ... on Commit { oid messageHeadline messageBody committedDate url author { name user { login } } } } }`);
      const cmps = compares.filter(c => c.repo === repo).map((c, j) =>
        `c${j}: ref(qualifiedName: ${q('refs/heads/' + c.base)}) { compare(headRef: ${q(c.head)}) { aheadBy commits(last: ${PENDING_SHOWN}) { nodes { oid messageHeadline messageBody url } } } }`);
      return `r${i}: repository(owner: ${q(owner)}, name: ${q(name)}) { ${[...tips, ...cmps].join(' ')} }`;
    });
    const res = await ghGraphql(`query { ${parts.join(' ')} }`);
    const out = { commits: {}, compares: {} };
    if (res.error) return { error: res.error, errorCode: res.errorCode || null };
    repos.forEach((repo, i) => {
      const node = res.data[`r${i}`];
      commits.filter(c => c.repo === repo).forEach((c, j) => {
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
          commits: cmp.commits.nodes.slice().reverse().map(n => ({ sha: n.oid, title: commitTitle(n.messageHeadline, n.messageBody), url: n.url })),
        };
      });
    });
    return { results: out };
  }

  async function refresh() {
    if (inFlight) return;
    inFlight = true;
    push({ loading: true });
    try {
      const loaded = await loadConfig(state.source);
      if (loaded.error) return push({ error: loaded.error, errorCode: loaded.errorCode || null, problems: null, grid: null });
      const problems = validateConfig(loaded.config);
      if (problems.length) return push({ error: null, errorCode: null, problems, grid: null });
      const fetched = await fetchResults(loaded.config);
      if (fetched.error) return push({ error: fetched.error, errorCode: fetched.errorCode, problems: null });
      push({ error: null, errorCode: null, problems: null, grid: buildGrid(loaded.config, fetched.results), updatedAt: Date.now() });
    } finally {
      inFlight = false;
      push({ loading: false });
      persist();
    }
  }

  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  function handle(msg) {
    switch (msg && msg.type) {
      case 'releasesOpen':
        send({ type: 'releases', state });
        refresh();
        stop(); timer = setInterval(refresh, REFRESH_MS);
        return true;
      case 'releasesClose': stop(); return true;
      case 'releasesRefresh': refresh(); return true;
      case 'releasesSetSource': {
        const source = String(msg.source || '').trim() || DEFAULT_SOURCE;
        push({ source, grid: null, problems: null, error: null, updatedAt: null });
        persist();
        refresh();
        return true;
      }
      default: return false;
    }
  }

  return { handle };
};
