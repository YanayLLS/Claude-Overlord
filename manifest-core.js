// Release manifests: one JSON file per prod release in the org's release-manifests repo — the
// shared, append-mostly record of what each release shipped (per repo: the PR, the prod commit
// before and after, who signed, the deploy's result) and of rollbacks. Pure: builds and updates
// manifests; releases-main.js does the GitHub I/O. Self-check: manifest-core.test.js
(function (root) {

const SCHEMA = 1;
const SIGNATURES_NEEDED = 2; // same rule as signoff-core
const DIR = 'releases';
const MANIFESTS_REPO = 'release-manifests';
const ID_RE = /^(\d{4}-\d{2}-\d{2})-(\d{2})$/;
const RELEASE_ID_RE = /<!-- release-id:([\d-]+) -->/;

const manifestPath = (id) => `${DIR}/${id}.json`;
const releaseIdMark = (id) => `<!-- release-id:${id} -->`;

// Next free id for the day: 2026-09-29-01, -02, … existing = file names or ids in the folder.
function nextId(existing, now = new Date()) {
  const day = new Date(now).toISOString().slice(0, 10);
  let n = 0;
  for (const e of existing || []) {
    const m = String(e).replace(/\.json$/, '').match(ID_RE);
    if (m && m[1] === day) n = Math.max(n, Number(m[2]));
  }
  return `${day}-${String(n + 1).padStart(2, '0')}`;
}

// A new pending manifest from a release run's prod rows (the ones with a PR).
// kind 'rollback' carries rollbackOf = the release it restores.
function newManifest({ id, kind = 'release', rollbackOf = null, env = 'prod', rows, opener, manual = [], flags = null, scope = null, now = Date.now() }) {
  return {
    schema: SCHEMA, id, kind, rollbackOf, env, status: 'pending', ...(scope ? { scope } : {}),
    openedAt: new Date(now).toISOString(), openedBy: opener || null, updatedAt: new Date(now).toISOString(),
    repos: (rows || []).filter(r => r.pr).map(r => ({
      repo: r.repo, label: r.label, source: r.source, target: r.target,
      pr: { number: r.pr.number, url: r.pr.url },
      baseSha: r.baseSha || null, headSha: r.headSha || null, ahead: r.ahead != null ? r.ahead : null, ...(r.extraFromTarget != null ? { extraFromTarget: r.extraFromTarget } : {}),
      mergeSha: null, mergedAt: null, closed: false, signers: [], deploy: r.deploy ? { workflow: r.deploy, state: 'waiting', url: null, at: null } : null,
    })),
    manual: (manual || []).map(m => ({ repo: m.repo, label: m.label, branch: m.branch, live: m.live || null })),
    flags: flags && flags.missing ? { missing: flags.missing } : null,
  };
}

// Overall status from the repos: pending (a PR still open) → merged (all merged) → deployed /
// deploy-failed (every CI deploy finished); abandoned when every PR closed unmerged. A release someone
// called off (m.cancelled) reads as cancelled, or partial when some of it had already merged.
function deriveStatus(m) {
  const repos = m.repos || [];
  if (!repos.length) return m.status;
  const open = repos.filter(r => !r.mergeSha && !r.closed);
  if (open.length) return 'pending';
  const merged = repos.filter(r => r.mergeSha);
  if (m.cancelled) return merged.length ? 'partial' : 'cancelled';
  if (!merged.length) return 'abandoned';
  const deploys = merged.filter(r => r.deploy).map(r => r.deploy.state);
  if (deploys.some(s => s === 'failure')) return 'deploy-failed';
  if (deploys.every(s => s === 'success')) return 'deployed';
  return 'merged';
}

// Fold a PR's current state into its repo entry. Returns [manifest, changed].
function applyPr(m, repo, pr) {
  let changed = false;
  const repos = m.repos.map(r => {
    if (r.repo !== repo || r.pr.number !== pr.number) return r;
    const next = { ...r };
    if (pr.mergeSha && next.mergeSha !== pr.mergeSha) { next.mergeSha = pr.mergeSha; next.mergedAt = pr.mergedAt || null; }
    if (!pr.mergeSha && pr.closed && !next.closed) next.closed = true;
    if (pr.headSha && !next.mergeSha && next.headSha !== pr.headSha) next.headSha = pr.headSha;
    if (pr.signers && JSON.stringify(pr.signers) !== JSON.stringify(next.signers)) next.signers = pr.signers;
    if (pr.signedSha && !next.mergeSha && next.signedSha !== pr.signedSha) next.signedSha = pr.signedSha;
    // merged without two approvers' signatures (e.g. on github.com): the audit exception
    if (next.mergeSha && (m.env || 'prod') === 'prod') next.unsigned = (next.signers || []).length < SIGNATURES_NEEDED; // only prod is signed
    if (JSON.stringify(next) !== JSON.stringify(r)) changed = true;
    return next;
  });
  return finish(m, repos, changed);
}

// Fold the deploy run that shipped a repo's merge commit. run: { state, url, at }.
function applyDeploy(m, repo, run) {
  let changed = false;
  const repos = m.repos.map(r => {
    if (r.repo !== repo || !r.deploy || !run || !['success', 'failure'].includes(run.state)) return r;
    if (r.deploy.state === run.state && r.deploy.url === run.url) return r;
    changed = true;
    return { ...r, deploy: { ...r.deploy, state: run.state, url: run.url || null, at: run.at || null } };
  });
  return finish(m, repos, changed);
}

function finish(m, repos, changed, now = Date.now()) {
  if (!changed) return [m, false];
  const next = { ...m, repos };
  next.status = deriveStatus(next);
  next.updatedAt = new Date(now).toISOString();
  return [next, true];
}

// What a rollback to manifest m has to do: per repo it merged, restore that merge commit's
// tree on top of the prod branch's current head. heads: { repo: currentHeadSha }.
// skip = repos the user unticked. A repo already at that commit needs nothing.
function rollbackPlan(m, heads, skip = []) {
  const out = [];
  for (const r of m.repos || []) {
    if (!r.mergeSha || skip.includes(r.repo)) continue;
    const head = heads[r.repo];
    out.push({ repo: r.repo, label: r.label, target: r.target, toSha: r.mergeSha, fromSha: head || null, noop: head === r.mergeSha });
  }
  return out;
}

// Past releases from merged release PRs (for a history that starts before manifests existed):
// PRs merged within `gapMs` of each other are one release. prs: [{ repo, label, source, target,
// deploy, number, url, mergedAt, mergeSha, baseSha, headSha, author }]. Newest `max` releases,
// oldest first, with ids by merge day.
function groupPast(prs, { gapMs = 3 * 3600e3, max = 30 } = {}) {
  const sorted = [...prs].sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt));
  const groups = [];
  for (const p of sorted) {
    const g = groups[groups.length - 1];
    if (g && Date.parse(p.mergedAt) - Date.parse(g[g.length - 1].mergedAt) <= gapMs && !g.some(x => x.repo === p.repo)) g.push(p);
    else groups.push([p]);
  }
  const kept = groups.slice(-max), ids = [];
  return kept.map(g => {
    const id = nextId(ids, new Date(g[0].mergedAt)); ids.push(id);
    const m = newManifest({ id, rows: g.map(p => ({ repo: p.repo, label: p.label, source: p.source, target: p.target, deploy: p.deploy,
      pr: { number: p.number, url: p.url }, baseSha: p.baseSha, headSha: p.headSha })), opener: { login: g[0].author, clickup: null }, now: Date.parse(g[0].mergedAt) });
    m.imported = true;
    m.repos = m.repos.map(r => { const p = g.find(x => x.repo === r.repo); return { ...r, mergeSha: p.mergeSha, mergedAt: p.mergedAt }; });
    m.status = deriveStatus(m);
    return m;
  });
}

// The manifest id a release PR belongs to (written into its body by Overlord).
function releaseIdOf(body) { const m = String(body || '').match(RELEASE_ID_RE); return m ? m[1] : null; }

// Record that `by` called the release off; the repos it closed are the ones that never shipped.
function cancel(m, by, now = Date.now()) {
  const repos = m.repos.map(r => (!r.mergeSha && !r.closed ? { ...r, closed: true } : r));
  const next = { ...m, repos, cancelled: { by, at: new Date(now).toISOString(), never: repos.filter(r => !r.mergeSha).map(r => r.label) } };
  next.status = deriveStatus(next);
  next.updatedAt = next.cancelled.at;
  return next;
}

const api = { cancel, SCHEMA, DIR, MANIFESTS_REPO, manifestPath, releaseIdMark, nextId, newManifest, deriveStatus, groupPast, applyPr, applyDeploy, rollbackPlan, releaseIdOf };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.ManifestCore = api;
})(this);
