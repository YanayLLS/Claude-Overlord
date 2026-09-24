// Self-check for spare-core. Run: node spare-core.test.js
const assert = require('assert');
const { spareFits } = require('./spare-core');

const s = { cwd: 'C:\\repo', key: 'k1', exited: false };

// Same folder, same launch flags, still alive → adopt it.
assert.strictEqual(spareFits(s, 'C:\\repo', 'k1'), true);

// No spare yet.
assert.strictEqual(spareFits(null, 'C:\\repo', 'k1'), false);

// Different folder → claude's cwd is baked in at launch; can't reuse.
assert.strictEqual(spareFits(s, 'C:\\other', 'k1'), false);

// Flags changed since warming (bypass toggle, peers, feature siblings, MCP port) → stale.
assert.strictEqual(spareFits(s, 'C:\\repo', 'k2'), false);

// Spare's claude died while idle → never hand a dead terminal to a new agent.
assert.strictEqual(spareFits({ ...s, exited: true }, 'C:\\repo', 'k1'), false);

console.log('spare-core ok');
