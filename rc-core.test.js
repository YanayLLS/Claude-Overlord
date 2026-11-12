// Run: node rc-core.test.js
const assert = require('assert');
const { parseRunPage, flagsOn, categoryOf, grade, nightChain, testedShas, prodNight, redAt, aiPrompt } = require('./rc-core');

// ── a night, built small ──────────────────────────────
const fail = (module, name, o = {}) => ({ key: `${module}|${name}`, module, name, tags: o.tags || [], step: o.step || 'a step', error: 'boom',
  flaky: !!o.flaky, report: null, anchor: null, flags: o.flags || [] });
const mod = (name, passed = 10, failed = 0) => ({ name, title: name, passed, failed, flaky: 0, skipped: 0 });
const page = (failures = [], modules = [mod('a'), mod('b')], suites = []) => ({ runUrl: 'r', modules, failures, suites });
const history = (scenarios = {}, modules = { a: [[10, 0, 0]], b: [[10, 0, 0]] }) => ({ nights: ['2026-11-10', '2026-11-09'], scenarios, modules });
const base = { pageUrl: 'https://x/results/cucumber-report.run.html', evidence: 'nightly', prodAt: '2026-11-10T13:00:00Z', runAt: '2026-11-11T22:00:00Z', now: Date.parse('2026-11-12T06:00:00Z') };
const g = (o) => grade({ ...base, history: history(), ...o });
const rule = (r, id) => r.rules.find(x => x.id === id);

// a clean night ships
assert.strictEqual(g({ page: page() }).level, 'ship');
assert.strictEqual(g({ page: page() }).headline, 'Release.');
// no report at all is a hold, never a ship
assert.strictEqual(g({ page: null }).level, 'hold');

// ── critical ──────────────────────────────────────────
const crit = fail('a', 'Logs in', { tags: ['@critical'] });
// seen once, nobody examined it: look
assert.strictEqual(g({ page: page([crit]) }).level, 'look');
// red on the run before too: confirmed, hold
{
  const r = g({ page: page([crit]), history: history({ 'a|Logs in': 'FP' }) });
  assert.strictEqual(r.level, 'hold');
  assert.ok(r.headline.startsWith("Don't release."));
  assert.ok(r.headline.includes('Logs in'));
}
// already red the night prod last shipped (2026-11-09): prod has it, so it does not count
assert.strictEqual(g({ page: page([crit]), history: history({ 'a|Logs in': 'FF' }) }).level, 'ship');
// passed on its rerun: flaky, not a failure
assert.strictEqual(g({ page: page([fail('a', 'Logs in', { tags: ['@critical'], flaky: true })]) }).level, 'ship');

// ── what the fixer concluded ──────────────────────────
const cause = (o) => ({ key: 'k1', profile: 'a', scenarios: [{ profile: 'a', scenario: 'Logs in' }], ...o });
assert.strictEqual(categoryOf(cause({ verdict: 'fixed', riskTier: 'T1' })), 'test');
assert.strictEqual(categoryOf(cause({ verdict: 'fixed', riskTier: 'T2' })), 'repaired');
assert.strictEqual(categoryOf(cause({ verdict: 'declined', declineReason: 'over-group-cap' })), 'unexamined');
assert.strictEqual(categoryOf(cause({ verdict: 'declined', diagnosis: 'environmental: mongod hung' })), 'env');
assert.strictEqual(categoryOf(cause({ verdict: 'declined', diagnosis: 'spec-change: moved on purpose', productQuestions: ['which?'] })), 'spec');
assert.strictEqual(categoryOf(cause({ verdict: 'declined', category: 'product', diagnosis: 'environmental' })), 'product'); // its own word wins
// the test was wrong and the fixer fixed it: no risk on the nightly's own evidence…
assert.strictEqual(g({ page: page([crit]), history: history({ 'a|Logs in': 'FP' }), phase: { causes: [cause({ verdict: 'fixed', riskTier: 'T1' })] } }).level, 'ship');
// …but still red in the verify run means the fix did not hold
assert.strictEqual(g({ page: page([crit]), history: history({ 'a|Logs in': 'FP' }), evidence: 'verify', phase: { causes: [cause({ verdict: 'fixed', riskTier: 'T1' })] } }).level, 'hold');
// the fixer says the app is broken: hold on the first night
assert.strictEqual(g({ page: page([crit]), phase: { causes: [cause({ verdict: 'declined', category: 'product' })] } }).level, 'hold');
// behaviour moved on purpose: a product question, look
{
  const r = g({ page: page([crit]), phase: { causes: [cause({ verdict: 'declined', diagnosis: 'spec-change', productQuestions: ['Which is right?'] })] } });
  assert.strictEqual(r.level, 'look');
  assert.ok(rule(r, 'spec').items[0].text.includes('Which is right?'));
}
// one dead runner behind many scenarios is one cause, and not the app
{
  const many = Array.from({ length: 40 }, (_, i) => fail('a', `S${i}`, { tags: ['@critical'] }));
  const r = g({ page: page(many), phase: { causes: [{ key: 'mongo', verdict: 'declined', diagnosis: 'Environmental: mongod aborted', scenarios: many.map(f => ({ profile: 'a', scenario: f.name })) }] } });
  assert.strictEqual(r.level, 'look');
  assert.strictEqual(rule(r, 'critical').level, 'ship');
  assert.ok(rule(r, 'evidence').text.startsWith('40 scenarios hit a broken runner'));
}
// the fixer patched app code: the release needs that patch
assert.strictEqual(rule(g({ page: page(), apply: { highestTier: 'T2', commits: [{ module: 'a', riskTier: 'T2', cause: 'x' }] } }), 'fixer').level, 'look');
assert.strictEqual(rule(g({ page: page(), apply: { highestTier: 'T1', commits: [{ module: 'a', riskTier: 'T1' }] } }), 'fixer').level, 'ship');
assert.strictEqual(rule(g({ page: page(), verify: { decision: 'invalid' } }), 'fixer').level, 'look');
assert.ok(rule(g({ page: page(), verify: { decision: 'cancelled' } }), 'fixer').text.includes('never finished'));

// ── minor ─────────────────────────────────────────────
const minors = (n, modules = 1) => Array.from({ length: n }, (_, i) => fail(`m${i % modules}`, `S${i}`, { step: `step ${i}` }));
assert.strictEqual(rule(g({ page: page(minors(5)) }), 'minor').level, 'ship');
assert.strictEqual(rule(g({ page: page(minors(6)) }), 'minor').level, 'look');
assert.strictEqual(rule(g({ page: page(minors(4, 4)) }), 'minor').level, 'look'); // few, but all over the product
assert.strictEqual(rule(g({ page: page(minors(16)) }), 'minor').level, 'hold');
assert.strictEqual(rule(g({ page: page(minors(16)), policy: { minorLook: 20 } }), 'minor').level, 'look'); // the config's policy wins

// ── unreleased features ───────────────────────────────
assert.deepStrictEqual(flagsOn([{ name: 'the "IsCommentsEnabled" feature flag is "enabled"' }, { name: 'the "IsX" feature flag is "disabled" for "w"' }]), ['IsCommentsEnabled']);
{
  const hidden = fail('a', 'Comments post', { tags: ['@critical'], flags: ['IsCommentsEnabled'] });
  const hist = history({ 'a|Comments post': 'FP' });
  assert.strictEqual(g({ page: page([hidden]), history: hist }).level, 'hold');
  const r = g({ page: page([hidden]), history: hist, unreleased: ['IsCommentsEnabled'] });
  assert.strictEqual(r.level, 'ship');
  assert.ok(rule(r, 'unreleased').items[0].text.startsWith('IsCommentsEnabled'));
}

// ── is the evidence whole ─────────────────────────────
const hist20 = (red = false) => history({}, Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`m${i}`, [[10, red && i === 19 ? 1 : 0, 0]]])));
const ran = (n) => Array.from({ length: n }, (_, i) => mod(`m${i}`));
assert.strictEqual(rule(g({ page: page([], ran(20)), history: hist20() }), 'evidence').level, 'ship');
assert.strictEqual(rule(g({ page: page([], ran(18)), history: hist20() }), 'evidence').level, 'ship'); // 10% missing, green last time: carried
assert.ok(rule(g({ page: page([], ran(18)), history: hist20() }), 'evidence').text.includes('carried'));
assert.strictEqual(rule(g({ page: page([], ran(16)), history: hist20() }), 'evidence').level, 'look'); // 20%
assert.strictEqual(rule(g({ page: page([], ran(12)), history: hist20() }), 'evidence').level, 'hold'); // 40%
assert.strictEqual(rule(g({ page: page([], ran(19)), history: hist20(true) }), 'evidence').level, 'hold'); // the missing one was red
// a module that has not reported for nights is not part of the suite any more
assert.strictEqual(rule(g({ page: page([], [mod('a')]), history: history({}, { a: [[10, 0, 0]], gone: [null, null, null, [5, 0, 0]] }) }), 'evidence').level, 'ship');

// ── coverage, other suites, age ───────────────────────
assert.strictEqual(rule(g({ page: page([], [mod('a', 6), mod('b')]) }), 'coverage').level, 'look'); // 10 → 6 scenarios
assert.strictEqual(rule(g({ page: page([], [mod('a', 9), mod('b')]) }), 'coverage').level, 'ship');
const suite = (id, status) => ({ id, title: id, repo: 'web', sha: 'abc', status, failed: 1 });
assert.strictEqual(rule(g({ page: page([], undefined, [suite('jest', 'fail')]) }), 'checks').level, 'look');
assert.strictEqual(rule(g({ page: page([], undefined, [suite('jest', 'fail')]), prevPage: page([], undefined, [suite('jest', 'fail')]) }), 'checks').level, 'ship'); // already red
assert.strictEqual(g({ page: page(), now: Date.parse('2026-11-13T12:00:00Z') }).level, 'look'); // 38 h old
assert.strictEqual(g({ page: page(), now: Date.parse('2026-11-16T12:00:00Z') }).level, 'hold');

// ── history helpers ───────────────────────────────────
assert.strictEqual(prodNight(history(), '2026-11-10T13:00:00Z'), 1);
assert.strictEqual(prodNight(history(), '2026-11-01T00:00:00Z'), -1);
assert.strictEqual(redAt({ scenarios: { k: 'P-F' } }, 'k', 1), true);  // did not run that night: its last run before it
assert.strictEqual(redAt({ scenarios: { k: 'FPP' } }, 'k', 1), false);
assert.strictEqual(redAt({ scenarios: {} }, 'k', 0), false);

// ── the report page ───────────────────────────────────
{
  const data = { runUrl: 'https://gh/run/1', inProgress: { done: 1, total: 2 }, profiles: [{ name: 'a', title: 'A', passed: 3, failed: 1, flaky: 0, skipped: 0 }],
    failures: [{ profile: 'a', name: 'S', tags: ['@critical'], step: 'Then x', error: 'E1\n  at y', rerun: 'failed again', report: '../b1/results/r.html', anchor: 'id1',
      steps: [{ name: 'the "IsX" feature flag is "enabled"' }] }, { profile: 'a', name: 'T', rerun: 'passed on rerun' }],
    checks: { suites: [{ id: 'jest', repo: 'web', sha: 'abc', status: 'fail', failed: 2 }] } };
  const p = parseRunPage(`<html><script id="run-data" type="application/json">${JSON.stringify(data)}</script></html>`);
  assert.strictEqual(p.failures[0].key, 'a|S');
  assert.strictEqual(p.failures[0].error, 'E1');
  assert.deepStrictEqual(p.failures[0].flags, ['IsX']);
  assert.strictEqual(p.failures[1].flaky, true);
  assert.strictEqual(p.suites[0].sha, 'abc');
  const r = grade({ ...base, page: p, pageUrl: 'https://cdn/regression/1-1/results/cucumber-report.run.html', history: history({ 'a|S': 'FP' }, { a: [[3, 1, 0]] }) });
  assert.strictEqual(rule(r, 'critical').items[0].url, 'https://cdn/regression/1-1/b1/results/r.html#id1'); // straight to the scenario
  assert.deepStrictEqual(testedShas(p, { baseSha: 'f00' }), { web: 'abc', 'frontlineio-frontend': 'f00' });
  assert.strictEqual(parseRunPage('<html></html>'), null);
}

// ── the night's chain ─────────────────────────────────
{
  const runs = [{ id: 5, event: 'workflow_dispatch', createdAt: '2026-11-12T05:00:00Z' }, { id: 4, event: 'workflow_dispatch', createdAt: '2026-11-12T03:00:00Z' },
    { id: 3, event: 'schedule', createdAt: '2026-11-11T22:00:00Z' }, { id: 2, event: 'workflow_dispatch', createdAt: '2026-11-11T03:00:00Z' }, { id: 1, event: 'schedule', createdAt: '2026-11-10T22:00:00Z' }];
  const c = nightChain(runs);
  assert.strictEqual(c.nightly.id, 3);
  assert.strictEqual(c.previous.id, 1);
  assert.deepStrictEqual(c.after.map(r => r.id), [4, 5]);
  assert.strictEqual(nightChain([{ id: 9, event: 'workflow_dispatch', createdAt: '2026-11-12T05:00:00Z' }]), null);
}

// the AI is told the grade, and told not to argue with it
{
  const r = g({ page: page([crit]), history: history({ 'a|Logs in': 'FP' }) });
  const p = aiPrompt(r, { failures: '- a: Logs in | boom' });
  assert.ok(p.includes('HOLD') && p.includes('Do not contradict the grade') && p.includes('Logs in | boom'));
}

console.log('rc-core: ok');
