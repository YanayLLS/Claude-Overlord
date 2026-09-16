// When will a PR's running checks finish? GitHub has no ETA, so we make one:
// each running workflow's start time plus the median duration of that workflow's
// recent successful runs. The PR's ETA is the latest of those.

// REST /actions/runs rows → { workflowName: medianMs }.
function medianDurations(runs) {
  const by = {};
  for (const r of runs || []) {
    const a = Date.parse(r.run_started_at || r.created_at), b = Date.parse(r.updated_at);
    if (!r.name || !(a > 0) || !(b > a)) continue;
    (by[r.name] = by[r.name] || []).push(b - a);
  }
  const out = {};
  for (const n of Object.keys(by)) { const v = by[n].sort((x, y) => x - y); out[n] = v[Math.floor(v.length / 2)]; }
  return out;
}

// StatusCheckRollup.contexts nodes → [{ name, startedAt }] one per still-running workflow (earliest start wins).
function runningWorkflows(nodes) {
  const seen = {};
  for (const n of nodes || []) {
    if (!n || n.__typename !== 'CheckRun' || n.status === 'COMPLETED') continue;
    const wr = n.checkSuite && n.checkSuite.workflowRun;
    const name = wr && wr.workflow && wr.workflow.name;
    if (!name || !wr.createdAt) continue;
    if (!seen[name] || wr.createdAt < seen[name]) seen[name] = wr.createdAt;
  }
  return Object.keys(seen).map(name => ({ name, startedAt: seen[name] }));
}

// → epoch ms when the last running workflow should finish, or null when no
// running workflow has history (a first-ever run can't be estimated).
function checksEta(running, durations) {
  let eta = null;
  for (const w of running || []) {
    const d = durations && durations[w.name], s = Date.parse(w.startedAt);
    if (!(d > 0) || !(s > 0)) continue;
    if (eta === null || s + d > eta) eta = s + d;
  }
  return eta;
}

// Words for the row: '~4 min left' | 'any moment' | 'running long'.
function etaWords(etaMs, nowMs) {
  const left = etaMs - nowMs;
  if (left > 90000) return '~' + Math.round(left / 60000) + ' min left';
  if (left > -60000) return 'any moment';
  return 'running long';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { medianDurations, runningWorkflows, checksEta, etaWords };
}
