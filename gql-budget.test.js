const test = require('node:test');
const assert = require('node:assert');
const { gqlAllow } = require('./gql-budget');

const now = 1000e3, g = (remaining) => ({ remaining, limit: 5000, reset: (now + 30 * 60e3) / 1000 });

test('under the floor nothing runs and the pause lasts until the reset', () => {
  for (const kind of ['regular', 'triggered', 'other']) assert.deepStrictEqual(gqlAllow(kind, g(100), { now }), { ok: false, pausedUntil: now + 30 * 60e3 });
});

test('regular polls stretch to every 5 min when low', () => {
  assert.strictEqual(gqlAllow('regular', g(4000), { now, lastRegular: now - 1000 }).ok, true);
  assert.strictEqual(gqlAllow('regular', g(1000), { now, lastRegular: now - 60e3 }).ok, false);
  assert.strictEqual(gqlAllow('regular', g(1000), { now, lastRegular: now - 6 * 60e3 }).ok, true);
});

test('triggered polls need 70% left and at most 30 in the last hour; unknown budget denies them only', () => {
  assert.strictEqual(gqlAllow('triggered', g(3600), { now }).ok, true);
  assert.strictEqual(gqlAllow('triggered', g(3400), { now }).ok, false);
  assert.strictEqual(gqlAllow('triggered', g(5000), { now, triggeredAt: Array(30).fill(now - 60e3) }).ok, false);
  assert.strictEqual(gqlAllow('triggered', g(5000), { now, triggeredAt: Array(30).fill(now - 3700e3) }).ok, true);
  assert.strictEqual(gqlAllow('triggered', null).ok, false);
  assert.strictEqual(gqlAllow('regular', null).ok, true);
});
