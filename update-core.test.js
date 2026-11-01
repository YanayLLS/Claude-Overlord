// Run: node update-core.test.js
const assert = require('assert');
const { hasTrackedChanges, pullBlocker, needsInstall, updateLabel, npmRewriteOnly } = require('./update-core');

// ── hasTrackedChanges ─────────────────────────────────
assert.strictEqual(hasTrackedChanges(''), false);
assert.strictEqual(hasTrackedChanges(null), false);
assert.strictEqual(hasTrackedChanges('?? scratch.txt\n?? node_modules/\n'), false); // untracked only
assert.strictEqual(hasTrackedChanges(' M main.js\n'), true);
assert.strictEqual(hasTrackedChanges('M  index.html\n?? junk\n'), true);
assert.strictEqual(hasTrackedChanges('D  gone.js'), true);
assert.strictEqual(hasTrackedChanges('A  new.js'), true);
// a filename that merely starts with ? is not an untracked marker
assert.strictEqual(hasTrackedChanges(' M ??weird.js'), true);

// ── pullBlocker ───────────────────────────────────────
assert.strictEqual(pullBlocker({ porcelain: '', ahead: 0 }), null);
assert.strictEqual(pullBlocker({ porcelain: '?? tmp.log\n', ahead: 0 }), null); // untracked is fine
assert.match(pullBlocker({ porcelain: ' M main.js', ahead: 0 }), /uncommitted/);
assert.match(pullBlocker({ porcelain: '', ahead: 2 }), /2 unpushed commits/);
assert.match(pullBlocker({ porcelain: '', ahead: 1 }), /1 unpushed commit\b/);
// dirty wins over ahead — it's the one that loses work
assert.match(pullBlocker({ porcelain: ' M x.js', ahead: 3 }), /uncommitted/);

// ── needsInstall ──────────────────────────────────────
assert.strictEqual(needsInstall([]), false);
assert.strictEqual(needsInstall(null), false);
assert.strictEqual(needsInstall(['main.js', 'index.html']), false);
assert.strictEqual(needsInstall(['package.json']), true);
assert.strictEqual(needsInstall(['package-lock.json']), true);
assert.strictEqual(needsInstall(['scripts/package.json']), true); // nested workspace counts
// a lookalike name must not trigger a reinstall
assert.strictEqual(needsInstall(['docs/my-package.json']), false);

// ── npmRewriteOnly: npm install re-sorted / re-synced it, nothing a person wrote
const head = '{"name":"o","version":"1.2.0","devDependencies":{"b":"^1","a":"^2"}}';
assert.strictEqual(npmRewriteOnly('package.json', head, JSON.stringify({ name: 'o', version: '1.2.0', devDependencies: { a: '^2', b: '^1' } }, null, 2) + '\n'), true); // sorted + reformatted
assert.strictEqual(npmRewriteOnly('package.json', head, '{"name":"o","version":"1.3.0","devDependencies":{"b":"^1","a":"^2"}}'), false); // real edit kept
assert.strictEqual(npmRewriteOnly('package.json', head, '{"name":"o","version":"1.2.0","devDependencies":{"b":"^1","a":"^2","c":"^1"}}'), false); // added dep kept
assert.strictEqual(npmRewriteOnly('package.json', head, 'not json'), false);
assert.strictEqual(npmRewriteOnly('package-lock.json', '{}', '{"anything":1}'), true); // lock is npm output
assert.strictEqual(npmRewriteOnly('main.js', 'a', 'a'), false);

// ── updateLabel ───────────────────────────────────────
assert.strictEqual(updateLabel(0), null);
assert.strictEqual(updateLabel(-1), null);
assert.strictEqual(updateLabel(null), null);
assert.strictEqual(updateLabel(1), '⬇ Update (1 commit)');
assert.strictEqual(updateLabel(7), '⬇ Update (7 commits)');

console.log('ok — all update-core checks passed');
