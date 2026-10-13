// How far a deploy run is, and when a whole release will be deployed, from the last good run of each
// deploy workflow. No gh, no DOM. Self-check: deploy-eta.test.js
const dur = (a, b) => (a && b ? Math.max(0, Date.parse(b) - Date.parse(a)) : 0);

// liveJobs / baseJobs: GitHub's run jobs ({ name, status, started_at, completed_at, steps: [...] }).
// Each step of the good run weighs what it took there; the live run is done for the steps it finished,
// and for the running one up to what it took last time. Time left is the rest of the good run at this run's own
// pace so far (a slow runner today stays slow). → { pct 0..1, leftMs, step: name of the step running }
function runProgress(liveJobs, baseJobs, now = Date.now()) {
  const nowIso = new Date(now).toISOString();
  let total = 0, done = 0, step = null, start = null;
  for (const lj of liveJobs || []) if (lj.started_at && (!start || lj.started_at < start)) start = lj.started_at;
  for (const bj of baseJobs || []) {
    const lj = (liveJobs || []).find(j => j.name === bj.name);
    for (const bs of bj.steps || []) {
      const w = dur(bs.started_at, bs.completed_at);
      total += w;
      if (!lj) continue;
      if (lj.status === 'completed') { done += w; continue; }
      const ls = (lj.steps || []).find(s => s.name === bs.name);
      if (!ls) continue;
      if (ls.status === 'completed') done += w;
      else if (ls.status === 'in_progress') { done += Math.min(w * 0.95, dur(ls.started_at, nowIso)); step = step || ls.name; }
    }
  }
  if (!total) return { pct: null, leftMs: null, step };
  // pace: how long this run took for what the good run did in `done`; trusted once a minute of work is behind it
  // ponytail: one pace for the whole run, clamped 0.5–3×; per-step paces if a deploy mixes fast and slow phases
  const pace = done > 60000 && start ? Math.min(3, Math.max(0.5, dur(start, nowIso) / done)) : 1;
  return { pct: Math.min(0.99, done / total), leftMs: Math.round((total - done) * pace), step };
}

// A release's time left: its waves go one after another, a wave takes as long as its slowest repo.
// waves: [[{ s: 'done' | 'running' | 'todo', pct, leftMs, fullMs }]] → ms, or null when a repo's usual time is unknown
function releaseEtaMs(waves) {
  let ms = 0;
  for (const wave of waves) {
    let slowest = 0;
    for (const r of wave) {
      if (r.s === 'done') continue;
      if (!r.fullMs && r.leftMs == null) return null;
      slowest = Math.max(slowest, r.s === 'running' ? (r.leftMs != null ? r.leftMs : r.fullMs * (1 - (r.pct || 0))) : r.fullMs);
    }
    ms += slowest;
  }
  return ms;
}

const etaApi = { runProgress, releaseEtaMs };
if (typeof module !== 'undefined' && module.exports) module.exports = etaApi;
