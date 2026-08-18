// Self-check for term-size-core pure helpers. Run: node term-size-core.test.js
const assert = require('assert');
const { shouldSendResize } = require('./term-size-core');

// Nothing sent yet → the pty must hear the first real size.
assert.strictEqual(shouldSendResize(null, { cols: 120, rows: 30 }), true);

// Same size as last time → stay quiet (a drag fits on every frame).
assert.strictEqual(shouldSendResize({ cols: 120, rows: 30 }, { cols: 120, rows: 30 }), false);

// Width changed → the pty is now wrapping at the wrong column; tell it.
assert.strictEqual(shouldSendResize({ cols: 120, rows: 30 }, { cols: 96, rows: 30 }), true);

// Height changed → tell it too (Claude sizes its frame by rows).
assert.strictEqual(shouldSendResize({ cols: 120, rows: 30 }, { cols: 120, rows: 42 }), true);

// Degenerate measurements (panel closed / not laid out) are never worth sending.
assert.strictEqual(shouldSendResize({ cols: 120, rows: 30 }, { cols: 0, rows: 30 }), false);
assert.strictEqual(shouldSendResize({ cols: 120, rows: 30 }, { cols: 120, rows: 0 }), false);
assert.strictEqual(shouldSendResize(null, { cols: NaN, rows: NaN }), false);
assert.strictEqual(shouldSendResize({ cols: 120, rows: 30 }, null), false);

console.log('ok — all term-size-core checks passed');
