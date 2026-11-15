const test = require('node:test');
const assert = require('node:assert');
const { setupFailReason } = require('./worktree');

test('setupFailReason names the Node version an engine-strict install needs', () => {
  const log = 'npm error code EBADENGINE\nnpm error notsup Required: {"node":">=22.0.0"}\nnpm error notsup Actual:   {"npm":"10.8.2","node":"v20.20.0"}\n';
  assert.strictEqual(setupFailReason(log), 'Needs Node 22');
});
test('setupFailReason calls out a peer dependency conflict', () => {
  assert.strictEqual(setupFailReason('npm error code ERESOLVE\nnpm error ERESOLVE unable to resolve dependency tree\n'), 'Dependency conflict');
});
test('setupFailReason reports registry auth failures', () => {
  assert.strictEqual(setupFailReason('npm error code E401\nnpm error 401 Unauthorized - GET https://npm.pkg.github.com/x'), 'Registry login');
});
test('setupFailReason judges the last attempt, not the first', () => {
  assert.strictEqual(setupFailReason('npm error code ERESOLVE\n# npm install --legacy-peer-deps (retry)\nnpm error code EBADENGINE\nnpm error notsup Required: {"node":">=22.0.0"}'), 'Needs Node 22');
});
test('setupFailReason falls back to null for unknown failures', () => {
  assert.strictEqual(setupFailReason('something odd'), null);
});
