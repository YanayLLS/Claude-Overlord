// Self-check for setup-core. Run: node setup-core.test.js
const assert = require('assert');
const { SETUP_TOOLS, findTool, missingTools } = require('./setup-core');

const env = { PATH: 'C:\\Windows;C:\\Tools', USERPROFILE: 'C:\\Users\\u', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' };
const has = (...files) => f => files.includes(f);
const git = SETUP_TOOLS.find(t => t.id === 'git');
const claude = SETUP_TOOLS.find(t => t.id === 'claude');

// Git first: Claude Code on Windows needs Git Bash, so the card installs in this order.
assert.deepStrictEqual(SETUP_TOOLS.map(t => t.id), ['git', 'claude']);

// On PATH already → nothing to prepend.
assert.strictEqual(findTool(git, env, has('C:\\Tools\\git.exe')), 'path');
assert.strictEqual(findTool(claude, env, has('C:\\Tools\\claude.cmd')), 'path');

// Installed after login (stale GUI PATH) → the install dir to prepend.
assert.strictEqual(findTool(git, env, has('C:\\Program Files\\Git\\cmd\\git.exe')), 'C:\\Program Files\\Git\\cmd');
assert.strictEqual(findTool(claude, env, has('C:\\Users\\u\\.local\\bin\\claude.exe')), 'C:\\Users\\u\\.local\\bin');
assert.strictEqual(findTool(claude, env, has('C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd')), 'C:\\Users\\u\\AppData\\Roaming\\npm');

// Nowhere → null.
assert.strictEqual(findTool(git, env, has()), null);

// missingTools lists ids of tools found nowhere, in install order.
assert.deepStrictEqual(missingTools(env, has()), ['git', 'claude']);
assert.deepStrictEqual(missingTools(env, has('C:\\Tools\\git.exe')), ['claude']);
assert.deepStrictEqual(missingTools(env, has('C:\\Tools\\git.exe', 'C:\\Tools\\claude.exe')), []);

// A throwing exists() (bad path chars) counts as absent, never crashes boot.
assert.deepStrictEqual(missingTools(env, () => { throw new Error('EINVAL'); }), ['git', 'claude']);

console.log('setup-core ok');
