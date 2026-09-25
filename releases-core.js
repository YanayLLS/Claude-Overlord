// Pure helpers for the Releases board: which commit sits on each environment
// branch of each repo, and how much is waiting to be promoted to the next one.
// Shared by releases-main.js (fetching) and releases-ui.js (rendering). No DOM, no gh.
// Self-check: releases-core.test.js
// Wrapped so nothing leaks into the renderer's globals (actions-core.js already owns REPO_RE there).
(function (root) {

const DEFAULT_SOURCE = 'LLSLtd/frontlineio-frontend:.overlord/releases.json@dev';
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
// Everything spliced into a gh api path passes this first — ghJson goes through a
// shell on Windows. ponytail: stricter than git's branch rules; widen if a real branch trips it.
const SAFE_REF_RE = /^(?!.*\.\.)[\w.\/-]+$/;

// "owner/repo:path[@ref]" → fetched through gh; an absolute *.json path → read from disk.
function parseSource(str) {
  const s = String(str || '').trim();
  if (!s) return null;
  const gh = s.match(/^([\w.-]+\/[\w.-]+):([^@]+?)(?:@(.+))?$/);
  if (gh && !/^[a-z]:$/i.test(gh[1])) {
    const [, repo, path, ref = ''] = gh;
    if (!SAFE_REF_RE.test(path) || (ref && !SAFE_REF_RE.test(ref))) return null;
    return { kind: 'gh', repo, path, ref };
  }
  if (/^([a-z]:[\\/]|\/)/i.test(s) && /\.json$/i.test(s)) return { kind: 'file', path: s };
  return null;
}

// Every problem at once, each prefixed with where it is. [] means valid.
function validateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return ['config must be a JSON object'];
  const out = [];
  const envs = cfg.envs;
  if (!Array.isArray(envs) || !envs.length || envs.some(e => typeof e !== 'string' || !e)) {
    return ['envs: must be a non-empty array of names'];
  }
  envs.forEach((e, i) => { if (envs.indexOf(e) !== i) out.push(`envs[${i}]: "${e}" is listed twice`); });
  if (!Array.isArray(cfg.repos)) return [...out, 'repos: must be an array'];
  cfg.repos.forEach((r, i) => {
    const at = `repos[${i}]`;
    if (!r || typeof r !== 'object') { out.push(`${at}: must be an object`); return; }
    if (!REPO_RE.test(String(r.repo || ''))) out.push(`${at}.repo: "${r.repo}" is not owner/name`);
    if (r.group != null && typeof r.group !== 'string') out.push(`${at}.group: must be a string`);
    const hasBranches = r.branches != null, hasNote = r.note != null;
    if (hasBranches && hasNote) { out.push(`${at}: has both branches and note — pick one`); return; }
    if (!hasBranches && !hasNote) { out.push(`${at}: needs branches or note`); return; }
    if (hasNote) return;
    if (typeof r.branches !== 'object' || Array.isArray(r.branches)) { out.push(`${at}.branches: must be an object`); return; }
    for (const [env, branch] of Object.entries(r.branches)) {
      if (!envs.includes(env)) out.push(`${at}.branches.${env}: "${env}" is not in envs`);
      if (!SAFE_REF_RE.test(String(branch))) out.push(`${at}.branches.${env}: "${branch}" is not a valid branch name`);
    }
    if (r.deploy != null) {
      if (typeof r.deploy !== 'object' || Array.isArray(r.deploy)) out.push(`${at}.deploy: must be an object`);
      else for (const [env, how] of Object.entries(r.deploy)) {
        if (!Object.prototype.hasOwnProperty.call(r.branches, env)) out.push(`${at}.deploy.${env}: "${env}" is not in branches`);
        else if (how !== 'manual' && !/^[\w.-]+\.ya?ml$/.test(String(how))) out.push(`${at}.deploy.${env}: "${how}" is not a workflow file or "manual"`);
      }
    }
    if (r.promote == null) return;
    if (!Array.isArray(r.promote) || r.promote.length < 2) { out.push(`${at}.promote: needs at least 2 envs`); return; }
    r.promote.forEach((env, j) => {
      if (!Object.prototype.hasOwnProperty.call(r.branches, env)) out.push(`${at}.promote[${j}]: "${env}" is not in branches`);
    });
  });
  return out;
}

function promotePairs(r) {
  const p = r.promote || [];
  return p.slice(1).map((to, i) => ({ from: p[i], to }));
}

// The gh calls a refresh needs. Assumes a validated config.
function requestsFor(cfg) {
  const commits = [], compares = [], deploys = [];
  for (const r of cfg.repos) {
    if (!r.branches) continue;
    for (const env of cfg.envs) {
      if (!r.branches[env]) continue;
      commits.push({ repo: r.repo, env, branch: r.branches[env] });
      const file = r.deploy && r.deploy[env];
      if (file && file !== 'manual') deploys.push({ repo: r.repo, env, branch: r.branches[env], file });
    }
    for (const { from, to } of promotePairs(r)) {
      compares.push({ repo: r.repo, from, to, base: r.branches[to], head: r.branches[from] });
    }
  }
  return { commits, compares, deploys };
}

// View model: one row per repo, one cell per env (null = repo has no branch there).
// results.commits['repo|env'] and results.compares['repo|from'] — missing = still loading.
function buildGrid(cfg, results) {
  const commits = (results && results.commits) || {}, compares = (results && results.compares) || {}, deploys = (results && results.deploys) || {};
  const rows = cfg.repos.map((r) => {
    const label = r.label || r.repo.split('/')[1];
    const group = r.group || '';
    if (!r.branches) return { repo: r.repo, label, group, note: String(r.note) };
    const nextOf = {};
    for (const { from, to } of promotePairs(r)) nextOf[from] = to;
    const cells = cfg.envs.map((env) => {
      const branch = r.branches[env];
      if (!branch) return null;
      const res = commits[`${r.repo}|${env}`];
      const cell = { env, branch, deploy: (r.deploy && r.deploy[env]) || null, run: deploys[`${r.repo}|${env}`] || null, commit: null, error: null, missing: false, loading: !res, next: null };
      if (res && res.error) cell.error = res.error;
      else if (res && res.missing) cell.missing = true;
      else if (res) cell.commit = res;
      if (nextOf[env]) cell.next = compares[`${r.repo}|${env}`] || { to: nextOf[env], loading: true };
      return cell;
    });
    return { repo: r.repo, label, group, cells };
  });
  return { envs: cfg.envs.slice(), rows };
}

// A merge commit's headline ("Merge pull request #933 from org/branch") says nothing;
// GitHub puts the PR title on the body's first line.
function commitTitle(headline, body) {
  const m = String(headline || '').match(/^Merge pull request (#\d+) from /);
  const first = String(body || '').split('\n')[0].trim();
  return m && first ? `${m[1]} ${first}` : String(headline || '');
}

function age(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (isNaN(t)) return '';
  const m = Math.floor((now - t) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  if (m < 60 * 24) return `${Math.floor(m / 60)}h`;
  if (m < 60 * 24 * 14) return `${Math.floor(m / 1440)}d`;
  return `${Math.floor(m / 10080)}w`;
}

// A deploy workflow's run is red when ANY job fails, but a follow-up job (opening a PR,
// posting a ticket) failing after the deploy went out doesn't mean the env is broken.
// "partial" = the run failed but no failed job or step is a deploy one.
function runState(conclusion, failedJobs) {
  if (conclusion !== 'failure') return conclusion;
  if (!failedJobs || !failedJobs.length) return 'failure';
  return failedJobs.some(j => /deploy/i.test(j.job + ' ' + j.step)) ? 'failure' : 'partial';
}

// "label · env" for every cell whose last deploy run failed — what the footer badge warns about.
function failedDeploys(grid) {
  const out = [];
  for (const row of (grid && grid.rows) || []) {
    for (const c of row.cells || []) if (c && c.run && c.run.state === 'failure') out.push(row.label + ' · ' + c.env);
  }
  return out;
}

const api = { parseSource, validateConfig, requestsFor, buildGrid, failedDeploys, runState, age, commitTitle, DEFAULT_SOURCE, SAFE_REF_RE, REPO_RE };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.ReleasesCore = api;
})(this);
