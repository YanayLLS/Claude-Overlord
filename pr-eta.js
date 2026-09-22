// When will a PR's running checks finish? GitHub has no ETA, so we make one from
// each running workflow's start time and that workflow's recent successful runs.
// Consistent workflows get "~N min left"; erratic ones (a BDD suite that takes
// 7 minutes or 2 hours depending on profile) get elapsed time and the usual range.

// REST /actions/runs rows → { workflowName: { median, lo, hi } } in ms (quartiles).
// Runs under a minute are no-op runs (nothing to test) and are left out.
function durationStats(runs) {
  const by = {};
  for (const r of runs || []) {
    const a = Date.parse(r.run_started_at || r.created_at), b = Date.parse(r.updated_at);
    if (!r.name || !(a > 0) || !(b - a >= 60000)) continue;
    (by[r.name] = by[r.name] || []).push(b - a);
  }
  const out = {};
  for (const n of Object.keys(by)) {
    const v = by[n].sort((x, y) => x - y), q = f => v[Math.min(v.length - 1, Math.floor(v.length * f))];
    out[n] = { median: q(0.5), lo: q(0.25), hi: q(0.75) };
  }
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

// → the running workflow expected to finish last: { name, startedAt (ms), eta (ms),
// lo, hi, stable }. stable = its history is tight enough (p75 within 2x p25) to
// promise a time. null when no running workflow has history.
function checksEta(running, stats) {
  let best = null;
  for (const w of running || []) {
    const st = stats && stats[w.name], s = Date.parse(w.startedAt);
    if (!st || !(st.median > 0) || !(s > 0)) continue;
    const eta = s + st.median;
    if (!best || eta > best.eta) best = { name: w.name, startedAt: s, eta, lo: st.lo, hi: st.hi, stable: st.hi <= 2 * st.lo };
  }
  return best;
}

// Words for the row. Stable: '~4 min left' | 'any moment' | 'running long'.
// Erratic: '38 min in · usually 7–23 min'.
function etaWords(info, nowMs) {
  const min = ms => Math.max(1, Math.round(ms / 60000));
  if (!info.stable) return min(nowMs - info.startedAt) + ' min in · usually ' + min(info.lo) + '–' + min(info.hi) + ' min';
  const left = info.eta - nowMs;
  if (left > 90000) return '~' + min(left) + ' min left';
  if (left > -60000) return 'any moment';
  return 'running long';
}

// The PR's check state from its individual checks, not GitHub's rollup: the rollup
// says FAILURE the moment any run fails, even a cancelled run superseded by a rerun
// still in progress. Per check name the newest run wins; anything still running
// makes the PR 'pending', and `failed` counts the checks that have actually failed.
// → { checks: 'pass' | 'fail' | 'pending' | 'none', failed }
const BAD = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
function checkSummary(nodes) {
  const latest = {};
  for (const n of nodes || []) {
    if (!n) continue;
    const name = n.name || n.context;
    if (!name) continue;
    const at = n.startedAt || '';
    if (!latest[name] || at >= latest[name].at) latest[name] = { at, running: n.__typename === 'CheckRun' ? n.status !== 'COMPLETED' : n.state === 'PENDING' || n.state === 'EXPECTED', bad: BAD.has(n.conclusion || n.state) };
  }
  const all = Object.values(latest);
  if (!all.length) return { checks: 'none', failed: 0 };
  const failed = all.filter(c => c.bad && !c.running).length;
  return { checks: all.some(c => c.running) ? 'pending' : failed ? 'fail' : 'pass', failed };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { durationStats, runningWorkflows, checksEta, etaWords, checkSummary };
}
