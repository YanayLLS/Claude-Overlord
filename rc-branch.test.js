// Run: node rc-branch.test.js
const assert = require('assert');
const { rcName, rcRepos, rerunScopes, overlay, retireAction, supersededBy } = require('./rc-branch');

assert.strictEqual(rcName(77), 'rc/77');
// only tested repos the regression can be pointed at
assert.deepStrictEqual(rcRepos({ 'o/frontlineio-frontend': { sha: 'a', tested: true }, 'o/frontline.io-web': { sha: 'b', tested: true }, 'o/back-office': { sha: 'c', tested: false }, 'o/AI-chat-front': { sha: 'd', tested: true } }),
  { 'o/frontlineio-frontend': { tested: 'a', target: 'master' }, 'o/frontline.io-web': { tested: 'b', target: 'master' } });

const page = { modules: [{ name: 'flow', report: 'r' }, { name: 'room', report: 'r' }, { name: 'gone', report: null }, { name: 'onpremWorkers', report: 'r' }, { name: 'ok', report: 'r' }],
  failures: [{ module: 'flow', name: 'a' }, { module: 'room', name: 'b' }, { module: 'onpremWorkers', name: 'c' }, { module: 'ok', name: 'd', flaky: true }] };
// test-only fixes (or none merged) → failed + unreported modules, on-prem and flaky left out
assert.deepStrictEqual(rerunScopes({ page, files: [{ repo: 'o/frontlineio-frontend', path: 'tests/features/x.feature' }] }), ['flow', 'room', 'gone']);
assert.deepStrictEqual(rerunScopes({ page, files: [] }), ['flow', 'room', 'gone']);
// a product change, or a backend change → full
assert.strictEqual(rerunScopes({ page, files: [{ repo: 'o/frontlineio-frontend', path: 'src/a.ts' }] }), null);
assert.strictEqual(rerunScopes({ page, files: [{ repo: 'o/frontline.io-web', path: 'tests/a.js' }] }), null);

// overlay: re-run modules replaced, a module the re-run lost reads as unreported, the rest kept
const rerun = { modules: [{ name: 'flow', report: 'r2', passed: 3 }], failures: [] };
const o = overlay(page, rerun, ['flow', 'room']);
assert.deepStrictEqual(o.failures.map(f => f.module), ['onpremWorkers', 'ok']);
assert.strictEqual(o.modules.find(m => m.name === 'flow').report, 'r2');
assert.strictEqual(o.modules.find(m => m.name === 'room').report, null);

// retiring a branch
assert.strictEqual(retireAction({ ahead: 0 }), 'delete');
assert.strictEqual(retireAction({ ahead: 2 }), 'open');
assert.strictEqual(retireAction({ ahead: 2, pr: { state: 'open' } }), 'wait');
assert.strictEqual(retireAction({ ahead: 2, pr: { state: 'closed', merged: true } }), 'delete');

// superseded once the graded run is neither the rc's own run nor a run of its branch
const rc = { runId: 5, name: 'rc/5' };
assert.strictEqual(supersededBy(rc, { nightlyId: 5, ref: 'dev' }), false);
assert.strictEqual(supersededBy(rc, { nightlyId: 9, ref: 'rc/5' }), false);
assert.strictEqual(supersededBy(rc, { nightlyId: 9, ref: 'dev' }), true);

console.log('rc-branch: ok');
