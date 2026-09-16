const test = require('node:test');
const assert = require('node:assert');
const { medianDurations, runningWorkflows, checksEta, etaWords } = require('./pr-eta');

const T0 = '2026-09-16T10:00:00Z', ms = (iso) => Date.parse(iso);

test('medianDurations: per workflow name, ignores rows without usable times', () => {
  const runs = [
    { name: 'Tests', run_started_at: T0, updated_at: '2026-09-16T10:10:00Z' },
    { name: 'Tests', run_started_at: T0, updated_at: '2026-09-16T10:02:00Z' },
    { name: 'Tests', run_started_at: T0, updated_at: '2026-09-16T10:30:00Z' },
    { name: 'BDD', run_started_at: T0, updated_at: '2026-09-16T10:05:00Z' },
    { name: 'Broken', run_started_at: T0, updated_at: T0 },
    { run_started_at: T0, updated_at: '2026-09-16T10:05:00Z' },
  ];
  assert.deepStrictEqual(medianDurations(runs), { Tests: 10 * 60000, BDD: 5 * 60000 });
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

test('checksEta: latest projected finish; null when nothing running has history', () => {
  const running = [{ name: 'Tests', startedAt: T0 }, { name: 'BDD', startedAt: '2026-09-16T10:03:00Z' }, { name: 'New', startedAt: T0 }];
  assert.strictEqual(checksEta(running, { Tests: 10 * 60000, BDD: 5 * 60000 }), ms('2026-09-16T10:10:00Z'));
  assert.strictEqual(checksEta(running, { BDD: 20 * 60000 }), ms('2026-09-16T10:23:00Z'));
  assert.strictEqual(checksEta(running, {}), null);
  assert.strictEqual(checksEta([], { Tests: 1 }), null);
});

test('etaWords', () => {
  const now = ms(T0);
  assert.strictEqual(etaWords(now + 4 * 60000, now), '~4 min left');
  assert.strictEqual(etaWords(now + 30000, now), 'any moment');
  assert.strictEqual(etaWords(now - 30000, now), 'any moment');
  assert.strictEqual(etaWords(now - 5 * 60000, now), 'running long');
});

test('main.js PR query has balanced braces (GitHub rejects the whole query otherwise)', () => {
  const src = require('fs').readFileSync(__dirname + '/main.js', 'utf8');
  const m = src.match(/return `r\$\{i\}: repository[\s\S]*?`;/);
  assert.ok(m, 'query template not found');
  const q = m[0].replace(/`\s*\n\s*\+\s*`/g, '');
  assert.strictEqual((q.match(/\{/g) || []).length, (q.match(/\}/g) || []).length);
});
