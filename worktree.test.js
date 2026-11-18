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

const { adoptTarget, parseWorktrees } = require('./worktree');
test('parseWorktrees lists linked worktrees on a branch, not the main checkout or a detached one', () => {
  const out = 'worktree C:/Work/Designs\nHEAD aa\nbranch refs/heads/dev\n\nworktree C:/Work/Designs-xr\nHEAD bb\nbranch refs/heads/xr/ui-improve-wip\n\nworktree C:/Work/Designs-vc\nHEAD cc\ndetached\n';
  assert.deepStrictEqual(parseWorktrees(out), [{ path: require('path').resolve('C:/Work/Designs-xr'), branch: 'xr/ui-improve-wip' }]);
});
test('adoptTarget: a linked worktree on a branch joins with its main checkout as repo', () => {
  assert.deepStrictEqual(adoptTarget('C:\\Work\\Designs-xr', ['C:/Work/Designs', 'C:/Work/Designs-xr'], 'xr/ui-improve-wip'),
    { repo: require('path').resolve('C:/Work/Designs'), branch: 'xr/ui-improve-wip' });
});
test('adoptTarget refuses the main checkout, a detached head and an unknown folder', () => {
  assert.ok(adoptTarget('C:/Work/Designs', ['C:/Work/Designs', 'C:/Work/Designs-xr'], 'dev').error);
  assert.ok(adoptTarget('C:/Work/Designs-xr', ['C:/Work/Designs', 'C:/Work/Designs-xr'], '').error);
  assert.ok(adoptTarget('C:/Work/other', ['C:/Work/Designs'], 'x').error);
});
