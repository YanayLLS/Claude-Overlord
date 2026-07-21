// Run: node actions-core.test.js
const assert = require('assert');
const { parseWorkflowInput, runState, actionsRollup, nextPollDelay, diffNewFailures } = require('./actions-core');

// ── parseWorkflowInput ────────────────────────────────
assert.deepStrictEqual(
  parseWorkflowInput('https://github.com/LLSLtd/frontlineio-frontend/actions/workflows/deploy-ecs.yml'),
  { repo: 'LLSLtd/frontlineio-frontend', file: 'deploy-ecs.yml' });
assert.deepStrictEqual(
  parseWorkflowInput('  https://github.com/o/r/actions/workflows/ci.yaml?query=branch%3Amain  '),
  { repo: 'o/r', file: 'ci.yaml' });
assert.deepStrictEqual(parseWorkflowInput('LLSLtd/frontlineio-frontend'),
  { repo: 'LLSLtd/frontlineio-frontend', file: '' });
assert.deepStrictEqual(parseWorkflowInput('https://github.com/o/r'), { repo: 'o/r', file: '' });
assert.deepStrictEqual(parseWorkflowInput('https://github.com/o/r/actions'), { repo: 'o/r', file: '' });
assert.strictEqual(parseWorkflowInput('not a repo'), null);
assert.strictEqual(parseWorkflowInput(''), null);
assert.strictEqual(parseWorkflowInput(null), null);
// a non-github host must not be mistaken for owner/repo
assert.strictEqual(parseWorkflowInput('https://gitlab.com/o/r'), null);

// ── runState ──────────────────────────────────────────
assert.strictEqual(runState(null), 'none');
assert.strictEqual(runState({ status: 'in_progress' }), 'running');
assert.strictEqual(runState({ status: 'queued' }), 'running');
assert.strictEqual(runState({ status: 'waiting' }), 'running');
assert.strictEqual(runState({ status: 'completed', conclusion: 'success' }), 'success');
assert.strictEqual(runState({ status: 'completed', conclusion: 'failure' }), 'failure');
assert.strictEqual(runState({ status: 'completed', conclusion: 'timed_out' }), 'failure');
assert.strictEqual(runState({ status: 'completed', conclusion: 'cancelled' }), 'cancelled');
assert.strictEqual(runState({ status: 'completed', conclusion: 'skipped' }), 'cancelled');

// ── actionsRollup ─────────────────────────────────────
assert.strictEqual(actionsRollup([]).cls, 'hidden');
assert.deepStrictEqual(actionsRollup([{ state: 'success' }, { state: 'success' }]),
  { cls: '', text: '⚙ All 2 up to date' });
assert.deepStrictEqual(actionsRollup([{ state: 'success' }]),
  { cls: '', text: '⚙ All 1 up to date' });
assert.deepStrictEqual(actionsRollup([{ state: 'running' }, { state: 'failure' }]),
  { cls: 'running', text: '⚙ 1 running · 1 failed' });
assert.deepStrictEqual(actionsRollup([{ state: 'failure' }, { state: 'success' }]),
  { cls: 'alert', text: '⚙ 1 failed · 1 ok' });
// red only for MY failure; someone else's breakage is amber, same text
assert.deepStrictEqual(actionsRollup([{ state: 'failure', mine: true }]),
  { cls: 'alert', text: '⚙ 1 failed' });
assert.deepStrictEqual(actionsRollup([{ state: 'failure', mine: false }]),
  { cls: 'warn', text: '⚙ 1 failed' });
// mixed: one of them is mine → still red
assert.deepStrictEqual(actionsRollup([{ state: 'failure', mine: false }, { state: 'failure', mine: true }]),
  { cls: 'alert', text: '⚙ 2 failed' });
// unknown ownership must fail loud, not silently downgrade
assert.strictEqual(actionsRollup([{ state: 'failure' }]).cls, 'alert');
// running still outranks a failure of either kind
assert.strictEqual(actionsRollup([{ state: 'running' }, { state: 'failure', mine: true }]).cls, 'running');
// a per-row fetch error alone must not read as "up to date"
assert.deepStrictEqual(actionsRollup([{ state: 'success', error: 'boom' }]),
  { cls: 'err', text: '⚙ Actions — 1 check failed' });
// never-run workflows count as neither ok nor failed
assert.deepStrictEqual(actionsRollup([{ state: 'none' }]),
  { cls: '', text: '⚙ 1 never run' });

// ── nextPollDelay ─────────────────────────────────────
assert.strictEqual(nextPollDelay([{ state: 'running' }], 60), 10000);
assert.strictEqual(nextPollDelay([{ state: 'success' }], 60), 60000);
assert.strictEqual(nextPollDelay([{ state: 'success' }], 5), 30000);  // floor
assert.strictEqual(nextPollDelay([], 0), 60000);                      // default
assert.strictEqual(nextPollDelay([{ state: 'running' }], 300), 10000); // running beats interval

// ── diffNewFailures ───────────────────────────────────
const F = { key: 'o/r/d.yml', state: 'failure' };
// running -> failure is the transition we notify on
assert.deepStrictEqual(diffNewFailures([F], { 'o/r/d.yml': 'running' }), [F]);
assert.deepStrictEqual(diffNewFailures([F], { 'o/r/d.yml': 'success' }), [F]);
// still failing from last poll — already notified, stay quiet
assert.deepStrictEqual(diffNewFailures([F], { 'o/r/d.yml': 'failure' }), []);
// first sighting (no prior state) must not fire — e.g. app start, or newly added
assert.deepStrictEqual(diffNewFailures([F], {}), []);
assert.deepStrictEqual(diffNewFailures([F], null), []);
// non-failures never fire
assert.deepStrictEqual(diffNewFailures([{ key: 'k', state: 'success' }], { k: 'failure' }), []);
assert.deepStrictEqual(diffNewFailures([], { k: 'running' }), []);

console.log('ok — all actions-core checks passed');
