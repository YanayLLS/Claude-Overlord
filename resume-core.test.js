// Run: node resume-core.test.js
const assert = require('assert');
const { sessionSwitchKind } = require('./resume-core');

// full commands, with or without an argument
assert.strictEqual(sessionSwitchKind('/resume'), 'resume');
assert.strictEqual(sessionSwitchKind('  /resume abc123 '), 'resume');
assert.strictEqual(sessionSwitchKind('/clear'), 'clear');
// submitted from the slash menu: the typed prefix is all we saw
assert.strictEqual(sessionSwitchKind('/res'), 'resume');
assert.strictEqual(sessionSwitchKind('/resu'), 'resume');
assert.strictEqual(sessionSwitchKind('/cle'), 'clear');
// too short to be sure, or a different command
assert.strictEqual(sessionSwitchKind('/re'), null);
assert.strictEqual(sessionSwitchKind('/review'), null);
assert.strictEqual(sessionSwitchKind('/rename foo'), null);
assert.strictEqual(sessionSwitchKind('please /resume'), null);

console.log('resume-core: all tests passed');
