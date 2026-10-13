// Run: node deploy-eta.test.js
const assert = require('assert');
const { runProgress, releaseEtaMs } = require('./deploy-eta');

const t = (min) => new Date(Date.UTC(2026, 0, 1, 0, min)).toISOString();
const step = (name, a, b, status = 'completed') => ({ name, status, started_at: a == null ? null : t(a), completed_at: b == null ? null : t(b) });
// the last good run: build 4 min, upload 6 min
const base = [{ name: 'deploy', status: 'completed', steps: [step('build', 0, 4), step('upload', 4, 10)] }];

// build done, upload 3 of its usual 6 minutes in: (4 + 3) / 10
const live = [{ name: 'deploy', status: 'in_progress', started_at: t(0), steps: [step('build', 0, 4), step('upload', 4, null, 'in_progress')] }];
const p = runProgress(live, base, Date.parse(t(7)));
assert.strictEqual(Math.round(p.pct * 100), 70);
assert.strictEqual(p.step, 'upload');
// at the good run's pace: 3 of its 10 minutes left
assert.strictEqual(p.leftMs, 3 * 60000);
// twice as slow so far (build took 8, not 4): the rest is expected twice as slow too
const slow = [{ name: 'deploy', status: 'in_progress', started_at: t(0), steps: [step('build', 0, 8), step('upload', 8, null, 'in_progress')] }];
assert.strictEqual(runProgress(slow, base, Date.parse(t(8))).leftMs, 12 * 60000);
// slower than last time: never past 95% of a step, never 100% before it ends
assert.ok(runProgress(live, base, Date.parse(t(60))).pct < 1);
// queued (no steps yet), and no good run to compare with
assert.strictEqual(runProgress([{ name: 'deploy', status: 'queued', steps: [] }], base).pct, 0);
assert.strictEqual(runProgress(live, []).pct, null);

// waves one after another, each as slow as its slowest repo: 10 × 0.3 left, then max(8, 5)
const M = 60000;
assert.strictEqual(releaseEtaMs([[{ s: 'done' }, { s: 'running', pct: 0.7, fullMs: 10 * M }], [{ s: 'todo', fullMs: 8 * M }, { s: 'todo', fullMs: 5 * M }]]), 11 * M);
assert.strictEqual(releaseEtaMs([[{ s: 'todo' }]]), null, 'a repo with no usual time: no estimate');
assert.strictEqual(releaseEtaMs([[{ s: 'done' }]]), 0);
console.log('deploy-eta: all passed');
