// Self-check for setup-core. Run: node setup-core.test.js
const assert = require('assert');
const { SETUP_TOOLS, findTool, missingTools, progressLine } = require('./setup-core');

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

// progressLine: the installer's latest step, readable on one line of the card.
// Real piped winget output: CRLF lines, a URL per download.
const wg = 'Found Git [Git.Git] Version 2.55.0.5\r\nThis application is licensed to you by its owner.\r\n'
  + 'Downloading https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.5/Git-2.55.0.5-64-bit.exe\r\n';
assert.strictEqual(progressLine(wg), 'Downloading Git-2.55.0.5-64-bit.exe'); // URL → file name
assert.strictEqual(progressLine(wg + 'Starting package install...\r\n'), 'Starting package install...');
// Spinner frames redrawn with \r, ANSI colour, blank tail lines → the last real text.
assert.strictEqual(progressLine('Setting up Claude Code...\r\n  \r-\r\\\r|\r/\r\n\n'), 'Setting up Claude Code...');
assert.strictEqual(progressLine('\x1b[32mSuccessfully installed\x1b[0m\n'), 'Successfully installed');
// Long lines are capped so the card never grows.
assert.ok(progressLine('x'.repeat(500)).length <= 90);
assert.strictEqual(progressLine(''), '');

console.log('setup-core ok');
