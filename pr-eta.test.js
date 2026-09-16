const test = require('node:test');
const assert = require('node:assert');
const { durationStats, runningWorkflows, checksEta, etaWords } = require('./pr-eta');

const T0 = '2026-09-16T10:00:00Z', ms = (iso) => Date.parse(iso), M = 60000;
const run = (name, mins) => ({ name, run_started_at: T0, updated_at: new Date(ms(T0) + mins * M).toISOString() });

test('durationStats: quartiles per workflow, no-op runs under a minute dropped', () => {
  const runs = [run('Tests', 10), run('Tests', 2), run('Tests', 30), run('BDD', 5), run('BDD', 0.5), { name: 'Broken', run_started_at: T0, updated_at: T0 }, { run_started_at: T0, updated_at: '2026-09-16T10:05:00Z' }];
  assert.deepStrictEqual(durationStats(runs), { Tests: { median: 10 * M, lo: 2 * M, hi: 30 * M }, BDD: { median: 5 * M, lo: 5 * M, hi: 5 * M } });
});

test('runningWorkflows: one entry per unfinished workflow, earliest start kept', () => {
  const wr = (name, createdAt) => ({ checkSuite: { workflowRun: { createdAt, workflow: { name } } } });
  const nodes = [
    { __typename: 'CheckRun', status: 'IN_PROGRESS', ...wr('Tests', '2026-09-16T10:01:00Z') },
    { __typename: 'CheckRun', status: 'QUEUED', ...wr('Tests', T0) },
    { __typename: 'CheckRun', status: 'COMPLETED', ...wr('Lint', T0) },
    { __typename: 'StatusContext', state: 'PENDING' },
    { __typename: 'CheckRun', status: 'IN_PROGRESS', checkSuite: { workflowRun: null } },
  ];
  assert.deepStrictEqual(runningWorkflows(nodes), [{ name: 'Tests', startedAt: T0 }]);
});

test('checksEta: the workflow finishing last wins; stable only when history is tight', () => {
  const running = [{ name: 'Tests', startedAt: T0 }, { name: 'BDD', startedAt: '2026-09-16T10:03:00Z' }, { name: 'New', startedAt: T0 }];
  const tight = { median: 10 * M, lo: 9 * M, hi: 12 * M }, wild = { median: 12 * M, lo: 7 * M, hi: 23 * M };
  const a = checksEta(running, { Tests: tight, BDD: { median: 5 * M, lo: 5 * M, hi: 5 * M } });
  assert.strictEqual(a.name, 'Tests'); assert.strictEqual(a.eta, ms('2026-09-16T10:10:00Z')); assert.strictEqual(a.stable, true);
  const b = checksEta(running, { BDD: wild });
  assert.strictEqual(b.name, 'BDD'); assert.strictEqual(b.startedAt, ms('2026-09-16T10:03:00Z')); assert.strictEqual(b.stable, false);
  assert.strictEqual(checksEta(running, {}), null);
  assert.strictEqual(checksEta([], { Tests: tight }), null);
});

test('etaWords: countdown for stable workflows, elapsed + usual range for erratic ones', () => {
  const now = ms(T0), stable = (eta) => ({ stable: true, eta, startedAt: now - 5 * M, lo: M, hi: M });
  assert.strictEqual(etaWords(stable(now + 4 * M), now), '~4 min left');
  assert.strictEqual(etaWords(stable(now + 30000), now), 'any moment');
  assert.strictEqual(etaWords(stable(now - 30000), now), 'any moment');
  assert.strictEqual(etaWords(stable(now - 5 * M), now), 'running long');
  assert.strictEqual(etaWords({ stable: false, startedAt: now - 38 * M, eta: 0, lo: 7 * M, hi: 23 * M }, now), '38 min in · usually 7–23 min');
});

test('main.js PR query has balanced braces (GitHub rejects the whole query otherwise)', () => {
  const src = require('fs').readFileSync(__dirname + '/main.js', 'utf8');
  const m = src.match(/return `r\$\{i\}: repository[\s\S]*?`;/);
  assert.ok(m, 'query template not found');
  const q = m[0].replace(/`\s*\n\s*\+\s*`/g, '');
  assert.strictEqual((q.match(/\{/g) || []).length, (q.match(/\}/g) || []).length);
});
