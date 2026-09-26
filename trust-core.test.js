// Run: node trust-core.test.js
const assert = require('assert');
const { inheritTrust } = require('./trust-core');

const cfg = { projects: { 'C:/Work/Designs': { hasTrustDialogAccepted: true }, 'C:/Work/Other': { hasTrustDialogAccepted: false } } };
// a worktree of a trusted repo gets trusted; Windows paths match the config's / keys, any case
assert.strictEqual(inheritTrust(cfg, String.raw`c:\work\designs`, String.raw`C:\Users\y\.overlord\worktrees\Designs\fix-ci-1`), true);
assert.strictEqual(cfg.projects['C:/Users/y/.overlord/worktrees/Designs/fix-ci-1'].hasTrustDialogAccepted, true);
// already trusted → no change, so no rewrite of the file
assert.strictEqual(inheritTrust(cfg, 'C:/Work/Designs', 'C:/Users/y/.overlord/worktrees/Designs/fix-ci-1'), false);
// an untrusted or unknown repo passes nothing on
assert.strictEqual(inheritTrust(cfg, 'C:/Work/Other', 'C:/wt/o'), false);
assert.strictEqual(inheritTrust(cfg, 'C:/Work/Nope', 'C:/wt/n'), false);
assert.strictEqual(inheritTrust({}, 'C:/Work/Designs', 'C:/wt/d'), false);
// an existing entry keeps its other fields
const c2 = { projects: { 'C:/r': { hasTrustDialogAccepted: true }, 'C:/wt': { allowedTools: ['x'] } } };
assert.strictEqual(inheritTrust(c2, 'C:/r', 'C:/wt'), true);
assert.deepStrictEqual(c2.projects['C:/wt'], { allowedTools: ['x'], hasTrustDialogAccepted: true });
console.log('ok — trust-core checks passed');
