const assert = require('assert');
const { reasonsOf, rowsToFix, briefFor, MAX_TRIES } = require('./release-fix');
const { snapshotRef } = require('./release-run');

const row = (x = {}) => ({ repo: 'o/web', label: 'backend', source: 'dev', target: 'main', pr: { number: 7, url: 'u7' }, status: 'blocked', checks: 'pass', ...x });

// the two blockers of 2026-11-19: failing infra checks, a dbschemas field the lockfile does not ship
assert.deepStrictEqual(reasonsOf(row({ checks: 'fail' })), ['checks failing']);
assert.ok(reasonsOf(row({ dbschemas: { used: ['AvailableOnPrem'], shipped: '26.3.140', latest: '26.3.142' } }))[0].includes('AvailableOnPrem'));
// pending checks wait; a green row, a merged one or one without a PR is left alone
assert.deepStrictEqual(rowsToFix([row({ checks: 'pending', status: 'ok' }), row({ status: 'ok' }), row({ checks: 'fail', merged: true }), row({ checks: 'fail', pr: null })], 'r1'), []);
assert.strictEqual(rowsToFix([row({ checks: 'fail' })], 'r1').length, 1);
// two goes per release and repo, then a person looks
assert.strictEqual(rowsToFix([row({ checks: 'fail' })], 'r1', { 'r1|o/web': MAX_TRIES }).length, 0);
assert.strictEqual(rowsToFix([row({ checks: 'fail' })], 'r2', { 'r1|o/web': MAX_TRIES }).length, 1);
// the brief names the head branch the fix lands on and the source it goes back to
const b = briefFor([row({ checks: 'fail' })], { snapshotRef, workRoot: 'C:/Work' });
assert.ok(b.includes('`overlord/promote-dev-to-main`') && b.includes('source branch `dev`') && b.includes('checks failing'));
