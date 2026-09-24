// Self-check for shift-select-core. Run: node shift-select-core.test.js
const assert = require('assert');
const { shiftNavSeq, selRange, deleteSelSeq } = require('./shift-select-core');

assert.strictEqual(shiftNavSeq('ArrowLeft', false), '\x1b[D');
assert.strictEqual(shiftNavSeq('ArrowRight', true), '\x1bOC');
assert.strictEqual(shiftNavSeq('End', false), '\x1b[F');
assert.strictEqual(shiftNavSeq('ArrowLeft', true, true), '\x1b[1;5D'); // Ctrl+Shift → word jump
assert.strictEqual(shiftNavSeq('ArrowUp', false), null); // multi-row selection not handled

assert.deepStrictEqual(selRange(10, 13), { col: 10, len: 3 });
assert.deepStrictEqual(selRange(10, 7), { col: 7, len: 3 });

assert.strictEqual(deleteSelSeq(10, 12), '\x7f\x7f');         // selected rightward → backspace
assert.strictEqual(deleteSelSeq(10, 8), '\x1b[3~\x1b[3~');    // selected leftward → delete
assert.strictEqual(deleteSelSeq(10, 10), '');
