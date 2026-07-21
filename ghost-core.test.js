// Self-check for ghost-core pure helpers. Run: node ghost-core.test.js
const assert = require('assert');
const { parsePromptRow, extractContinuation } = require('./ghost-core');

// ── parsePromptRow ──
// '│ > fix the b        │' — cursor right after 'b' (col 13) → at end
let r = parsePromptRow('│ > fix the b        │', 13);
assert.deepStrictEqual(r, { ok: true, atEnd: true, prefix: 'fix the b' });

// same row, cursor after 'fix' (col 7) → not at end (text to the right)
r = parsePromptRow('│ > fix the b        │', 7);
assert.strictEqual(r.ok, true);
assert.strictEqual(r.atEnd, false);
assert.strictEqual(r.prefix, 'fix the b');

// hint/border line without a marker → not the input line
assert.strictEqual(parsePromptRow('│  Try "explain this"   │', 5).ok, false);

// not a bordered box at all → ignored
assert.strictEqual(parsePromptRow('just some scrollback text', 4).ok, false);

// alt marker + alt border char
assert.strictEqual(parsePromptRow('| ❯ hello |', 9).prefix, 'hello');

// ── extractContinuation ──
assert.strictEqual(extractContinuation('fix the b', 'fix the bug now'), 'ug now'); // echo stripped
assert.strictEqual(extractContinuation('add ', 'add a test for parser'), 'a test for parser');
assert.strictEqual(extractContinuation('write', '"a login form"'), 'a login form'); // quotes unwrapped
assert.strictEqual(extractContinuation('do x', 'line one\nline two'), 'line one'); // one line only
assert.strictEqual(extractContinuation('anything', ''), '');

console.log('ok — all ghost-core checks passed');
