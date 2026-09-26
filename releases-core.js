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
    if (r.uses != null) {
      if (typeof r.uses !== 'object' || Array.isArray(r.uses)) out.push(`${at}.uses: must be an object`);
      else for (const [env, other] of Object.entries(r.uses)) {
        if (!envs.includes(env)) out.push(`${at}.uses.${env}: "${env}" is not in envs`);
        else if (Object.prototype.hasOwnProperty.call(r.branches, env)) out.push(`${at}.uses.${env}: ${env} has its own branch`);
        else if (!Object.prototype.hasOwnProperty.call(r.branches, other)) out.push(`${at}.uses.${env}: "${other}" has no branch in this repo`);
      }
    }
    if (r.live != null) {
      if (typeof r.live !== 'object' || Array.isArray(r.live)) out.push(`${at}.live: must be an object`);
      else for (const [env, l] of Object.entries(r.live)) {
        if (!Object.prototype.hasOwnProperty.call(r.branches, env)) { out.push(`${at}.live.${env}: "${env}" is not in branches`); continue; }
        const src = parseSource(l && l.from);
        if (!src || src.kind !== 'gh') out.push(`${at}.live.${env}.from: must be owner/repo:path[@ref]`);
        if (!hasCaptureGroup(l && l.match)) out.push(`${at}.live.${env}.match: must be a regex with one (capture group) for the sha`);
      }
    }
    if (r.promote == null) return;
    // one path ["dev","alpha","prod"], or several that fork: [["dev","alpha"],["dev","prod"]]
    const nested = Array.isArray(r.promote) && Array.isArray(r.promote[0]);
    const chains = nested ? r.promote : [r.promote];
    chains.forEach((chain, i) => {
      const where = nested ? `${at}.promote[${i}]` : `${at}.promote`;
      if (!Array.isArray(chain) || chain.length < 2) { out.push(`${where}: needs at least 2 envs`); return; }
      chain.forEach((env, j) => {
        if (!Object.prototype.hasOwnProperty.call(r.branches, env)) out.push(`${where}[${j}]: "${env}" is not in branches`);
      });
    });
  });
  return out;
}

// Every from → to step of the promote path(s), each once.
function promotePairs(r) {
  const p = r.promote || [];
  const seen = new Set(), out = [];
  for (const chain of Array.isArray(p[0]) ? p : [p]) {
    chain.slice(1).forEach((to, i) => {
      const k = chain[i] + '>' + to;
      if (!seen.has(k)) { seen.add(k); out.push({ from: chain[i], to }); }
    });
  }
  return out;
}

// The gh calls a refresh needs. Assumes a validated config.
function requestsFor(cfg) {
  const commits = [], compares = [], deploys = [], lives = [];
  for (const r of cfg.repos) {
    if (!r.branches) continue;
    for (const env of cfg.envs) {
      if (!r.branches[env]) continue;
      commits.push({ repo: r.repo, env, branch: r.branches[env] });
      const l = r.live && r.live[env];
      if (l) lives.push({ repo: r.repo, env, branch: r.branches[env], from: l.from, match: l.match });
      const file = r.deploy && r.deploy[env];
      if (file && file !== 'manual') deploys.push({ repo: r.repo, env, branch: r.branches[env], file });
    }
    for (const { from, to } of promotePairs(r)) {
      compares.push({ repo: r.repo, from, to, base: r.branches[to], head: r.branches[from] });
    }
  }
  return { commits, compares, deploys, lives };
}

// View model: one row per repo, one cell per env (null = repo has no branch there).
// results.commits['repo|env'] and results.compares['repo|from>to'] — missing = still loading.
// cell.nexts = every step out of that env (a fork has several); cell.next = the first.
function buildGrid(cfg, results) {
  const commits = (results && results.commits) || {}, compares = (results && results.compares) || {}, deploys = (results && results.deploys) || {}, lives = (results && results.lives) || {};
  const rows = cfg.repos.map((r) => {
    const label = r.label || r.repo.split('/')[1];
    const group = r.group || '';
    if (!r.branches) return { repo: r.repo, label, group, note: String(r.note) };
    const nextOf = {};
    for (const { from, to } of promotePairs(r)) (nextOf[from] = nextOf[from] || []).push(to);
    const cells = cfg.envs.map((env) => {
      const branch = r.branches[env];
      // no deployment of its own: this env runs another env's (config `uses`), or nothing
      if (!branch) return r.uses && r.uses[env] ? { env, uses: r.uses[env] } : null;
      const res = commits[`${r.repo}|${env}`];
      const cell = { env, branch, deploy: (r.deploy && r.deploy[env]) || null, run: deploys[`${r.repo}|${env}`] || null, live: lives[`${r.repo}|${env}`] || null, commit: null, error: null, missing: false, loading: !res, next: null, nexts: [] };
      if (res && res.error) cell.error = res.error;
      else if (res && res.missing) cell.missing = true;
      else if (res) cell.commit = res;
      cell.nexts = (nextOf[env] || []).map(to => compares[`${r.repo}|${env}>${to}`] || { to, loading: true });
      cell.next = cell.nexts[0] || null;
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

function hasCaptureGroup(pattern) {
  try { return new RegExp(String(pattern) + '|').exec('').length > 1; } catch { return false; }
}

// The sha a pinning file (terraform tfvars, a manifest…) says is live: the regex's first
// capture group. null when nothing matches or the pattern is broken — "unknown", not a crash.
function liveSha(text, pattern) {
  try { const m = new RegExp(pattern).exec(String(text || '')); return (m && m[1]) || null; } catch { return null; }
}

// A deploy workflow's run is red when ANY job fails, but a follow-up job (opening a PR,
// posting a ticket) failing after the deploy went out doesn't mean the env is broken.
// "partial" = the run failed but no failed job or step is a deploy one.
// "dead" = the deploy failed and the workflow has never succeeded on this branch: whatever keeps this env
// running, it isn't this workflow, so its red run says nothing about the env.
// everSucceeded: undefined = not checked (treated as true).
function runState(conclusion, failedJobs, everSucceeded) {
  if (conclusion !== 'failure') return conclusion;
  // the deploy itself went through: a side job's red says nothing about the env
  if (failedJobs && failedJobs.length && !failedJobs.some(j => /deploy/i.test(j.job + ' ' + j.step))) return 'partial';
  // the deploy step failed — and if it has never once worked, it isn't how this env gets deployed
  return everSucceeded === false ? 'dead' : 'failure';
}

// A branch's own line of commits: tip, its first parent, that one's first parent… Each is the
// moment something LANDED on the branch (a merge, a squash, a direct push); the commits a merge
// brought along are skipped. nodes = GraphQL history (newest first) with parents(first: 1).
function firstParentChain(nodes, max) {
  const byOid = new Map((nodes || []).map(n => [n.oid, n]));
  const out = [];
  for (let n = nodes && nodes[0]; n && out.length < max; ) {
    out.push(n);
    const p = n.parents && n.parents.nodes && n.parents.nodes[0];
    n = p && byOid.get(p.oid);
  }
  return out;
}

// Timeline, newest first. Where CI deploys an env, its entries are the real deploy runs
// (kind 'deploy': when it went out, who, and whether it worked); elsewhere — manual deploys,
// or a CI workflow that never worked — what landed on the branch (kind 'merge'), since
// nothing records when it went live. A run that failed only in a side job while the env's
// latest run reads 'partial' is shown as partial too. Envs pinned via `live` are skipped.
// env = optional filter.
function buildTimeline(cfg, history, env, deploys) {
  const out = [];
  for (const r of cfg.repos) {
    if (!r.branches) continue;
    const label = r.label || r.repo.split('/')[1];
    for (const e of cfg.envs) {
      if (!r.branches[e] || (env && e !== env) || (r.live && r.live[e])) continue;
      const key = `${r.repo}|${e}`, d = deploys && deploys[key];
      const base = { repo: r.repo, label, env: e, branch: r.branches[e] };
      if (d && d.runs && d.state !== 'dead') {
        for (const run of d.runs) out.push({ ...base, ...run, kind: 'deploy', state: run.state === 'failure' && d.state === 'partial' ? 'partial' : run.state });
      } else {
        for (const c of (history && history[key]) || []) out.push({ ...base, ...c, kind: 'merge' });
      }
    }
  }
  return out.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
}

// "label · env" for every cell whose last deploy run failed — what the footer badge warns about.
function failedDeploys(grid) {
  const out = [];
  for (const row of (grid && grid.rows) || []) {
    for (const c of row.cells || []) if (c && c.run && c.run.state === 'failure') out.push(row.label + ' · ' + c.env);
  }
  return out;
}

const api = { parseSource, validateConfig, requestsFor, buildGrid, buildTimeline, firstParentChain, failedDeploys, runState, liveSha, age, commitTitle, DEFAULT_SOURCE, SAFE_REF_RE, REPO_RE };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.ReleasesCore = api;
})(this);
