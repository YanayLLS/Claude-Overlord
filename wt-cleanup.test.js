const test = require('node:test');
const assert = require('node:assert');
const c = require('./wt-cleanup');

test('prQueryArgs asks GitHub for every PR (any state) from the branch, as a cacheable GET', () => {
  assert.deepStrictEqual(c.prQueryArgs('acme/web', 'fix-x'),
    ['api', '-X', 'GET', '/repos/acme/web/pulls', '-f', 'head=acme:fix-x', '-f', 'state=all', '-f', 'per_page=10']);
  assert.strictEqual(c.prQueryArgs('bad', 'fix-x'), null);
  assert.strictEqual(c.prQueryArgs('acme/web', ''), null);
});

test('openPrOf: an open PR defers the delete to it; none, merged or closed deletes now', () => {
  assert.strictEqual(c.openPrOf([{ number: 7, state: 'open' }]), 7);
  assert.strictEqual(c.openPrOf([{ number: 3, state: 'closed', merged_at: '2026-01-01' }, { number: 9, state: 'open' }]), 9);
  assert.strictEqual(c.openPrOf([{ number: 3, state: 'closed', merged_at: '2026-01-01' }]), null);
  assert.strictEqual(c.openPrOf([]), null);
  assert.strictEqual(c.openPrOf({ message: 'Not Found', status: '404' }), null);
  assert.strictEqual(c.openPrOf(undefined), null);
});

test('cleanupVerdict: merged deletes, closed unmerged keeps, open or unknown waits', () => {
  const p = { pr: 7, path: 'C:/wt/fix-x' };
  assert.strictEqual(c.cleanupVerdict([{ number: 7, state: 'closed', merged_at: '2026-01-01T00:00:00Z' }], p), 'delete');
  assert.strictEqual(c.cleanupVerdict([{ number: 7, state: 'closed', merged_at: null }], p), 'keep');
  assert.strictEqual(c.cleanupVerdict([{ number: 7, state: 'open' }], p), 'wait');
  assert.strictEqual(c.cleanupVerdict([{ number: 8, state: 'closed', merged_at: 'x' }], p), 'wait'); // another PR's merge says nothing
  assert.strictEqual(c.cleanupVerdict({ message: 'rate limited' }, p), 'wait');
  assert.strictEqual(c.cleanupVerdict(undefined, p), 'wait');
});

test('cleanupVerdict: a folder back in use (re-added as a worktree) is never deleted', () => {
  const p = { pr: 7, path: 'C:/wt/fix-x' };
  assert.strictEqual(c.cleanupVerdict([{ number: 7, state: 'closed', merged_at: 'x' }], p, true), 'keep');
});

test('addPending replaces an older entry for the same folder', () => {
  const a = { path: 'C:/wt/A', pr: 1 }, b = { path: 'C:/wt/b', pr: 2 };
  assert.deepStrictEqual(c.addPending([a, b], { path: 'c:/wt/a', pr: 5 }), [b, { path: 'c:/wt/a', pr: 5 }]);
  assert.deepStrictEqual(c.addPending(undefined, a), [a]);
});
