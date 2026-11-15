// Run: node rc-fix.test.js
const assert = require('assert');
const { readResult, prNumber, briefFor, causeState, readyToMerge, checksVerdict } = require('./rc-fix');

// a result file is read only when it is whole and names a known status
assert.deepStrictEqual(readResult('{"status":"pr","url":"https://github.com/o/r/pull/12"}'), { status: 'pr', url: 'https://github.com/o/r/pull/12' });
assert.strictEqual(readResult('{"status":"pr"'), null);
assert.strictEqual(readResult('{"status":"maybe"}'), null);
assert.strictEqual(prNumber('https://github.com/o/r/pull/12'), 12);

// the brief tells the agent to look for someone else's fix first, on the base since the tested commit
const cause = { module: 'billing', critical: true, scenarios: ['Resuming puts the subscription back on renewal'], step: 'the billing page should show no status banner', error: 'boom', url: 'u' };
const b = briefFor({ cause, i: 2, nightlyId: 77, repo: 'o/r', base: 'dev', testedSha: 'abc123', reportUrl: 'r', runUrl: 'run', resultPath: 'C:/x/2.json', skill: 'S.md' });
assert.ok(b.includes('git log --oneline abc123..origin/dev') && b.includes('fixed-on-dev') && b.includes('open-elsewhere'));
assert.ok(b.includes('fix/rc-77-2') && b.includes('C:/x/2.json') && b.includes('@critical'));

// what the card shows per cause
assert.strictEqual(causeState({ started: false }).kind, 'idle');
assert.strictEqual(causeState({ started: true }).kind, 'working');
assert.strictEqual(causeState({ started: true, result: { status: 'fixed-on-dev', url: 'c', by: 'ahmad' } }).kind, 'fixed');
assert.strictEqual(causeState({ started: true, result: { status: 'declined', reason: 'r', question: 'q?' } }).kind, 'needs-you');
assert.strictEqual(causeState({ started: true, result: { status: 'pr', url: 'p' }, pr: { state: 'open', green: true } }).kind, 'green');
assert.strictEqual(causeState({ started: true, result: { status: 'pr', url: 'p' }, pr: { state: 'open', pending: true } }).kind, 'running');
assert.strictEqual(causeState({ started: true, result: { status: 'pr', url: 'p' }, pr: { state: 'closed', merged: true } }).kind, 'merged');
assert.strictEqual(causeState({ started: true, result: { status: 'open-elsewhere', url: 'p', by: 'yoav' }, pr: { state: 'open', green: true } }).mine, false);

// Merge & re-run waits for every agent, and needs at least one green PR of ours (or everything settled)
const green = { kind: 'green', mine: true };
assert.strictEqual(readyToMerge({ a: green, b: { kind: 'working' } }), false);
assert.strictEqual(readyToMerge({ a: green, b: { kind: 'red' } }), false);
assert.strictEqual(readyToMerge({ a: green, b: { kind: 'fixed' }, c: { kind: 'needs-you' } }), true);
assert.strictEqual(readyToMerge({ a: { kind: 'fixed' }, b: { kind: 'declined' } }), true); // nothing to merge, re-run still useful
assert.strictEqual(readyToMerge({}), false);

// check runs
assert.deepStrictEqual(checksVerdict([{ name: 'a', status: 'completed', conclusion: 'success' }, { name: 'b', status: 'completed', conclusion: 'skipped' }]), { green: true });
assert.deepStrictEqual(checksVerdict([{ name: 'a', status: 'in_progress' }]), { pending: true });
assert.deepStrictEqual(checksVerdict([{ name: 'a', status: 'completed', conclusion: 'failure' }]), { red: true });

console.log('rc-fix: ok');
