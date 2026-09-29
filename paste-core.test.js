// Self-check for paste-core. Run: node paste-core.test.js
const assert = require('assert');
const { pasteRoute, pasteIntoInput, normalizePasteText } = require('./paste-core');

// ── The bug this module exists for ──────────────────────
// Chromium hands over an empty DataTransfer when the clipboard read loses a
// race. items AND types are both empty, so neither can prove "no text" — the
// paste must reach main, which re-reads the OS clipboard, rather than being
// swallowed by a preventDefault with nothing behind it.
assert.strictEqual(pasteRoute({ hasTextItem: false, types: [] }), 'files');
assert.strictEqual(pasteRoute({}), 'files');

// Ordinary text paste: xterm handles it, so the listener must not preventDefault.
assert.strictEqual(pasteRoute({ hasTextItem: true, types: ['text/plain'] }), 'xterm');
// items empty but types intact — the case the old types check did catch.
assert.strictEqual(pasteRoute({ hasTextItem: false, types: ['text/plain'] }), 'xterm');
assert.strictEqual(pasteRoute({ hasTextItem: false, types: ['text'] }), 'xterm');

// Files and images keep their own routes, and files win over stray text
// (Explorer puts a text/plain flavour on the clipboard next to CF_HDROP).
assert.strictEqual(pasteRoute({ hasImageFile: true }), 'image');
assert.strictEqual(pasteRoute({ hasNonImageFile: true, hasTextItem: true, types: ['text/plain'] }), 'files');
assert.strictEqual(pasteRoute({ fileCount: 2, hasTextItem: true }), 'files');
// An image beats a file when both are present — Claude wants the bitmap.
assert.strictEqual(pasteRoute({ hasImageFile: true, hasNonImageFile: true }), 'image');

// A paste aimed at a real input is never the terminal's, whatever it carries.
assert.strictEqual(pasteRoute({ intoInput: true, hasImageFile: true }), 'ignore');
assert.strictEqual(pasteRoute({ intoInput: true, types: [] }), 'ignore');

// ── Which targets count as "a real input" ───────────────
assert.strictEqual(pasteIntoInput({ tag: 'INPUT' }), true);
assert.strictEqual(pasteIntoInput({ tag: 'TEXTAREA' }), true);
assert.strictEqual(pasteIntoInput({ tag: 'DIV', isContentEditable: true }), true);
// xterm's sink is a textarea too — it must fall through to the terminal.
assert.strictEqual(pasteIntoInput({ tag: 'TEXTAREA', className: 'xterm-helper-textarea' }), false);
assert.strictEqual(pasteIntoInput({ tag: 'TEXTAREA', className: 'a xterm-helper-textarea b' }), false);
// Substring lookalikes must not be mistaken for it.
assert.strictEqual(pasteIntoInput({ tag: 'TEXTAREA', className: 'not-xterm-helper-textarea-x' }), true);
assert.strictEqual(pasteIntoInput({ tag: 'DIV' }), false);
assert.strictEqual(pasteIntoInput({}), false);

// ── Line endings inside a bracketed paste ───────────────
assert.strictEqual(normalizePasteText('a\r\nb'), 'a\rb');
assert.strictEqual(normalizePasteText('a\nb'), 'a\rb');
assert.strictEqual(normalizePasteText('a\rb'), 'a\rb');       // already CR, untouched
assert.strictEqual(normalizePasteText('a\r\n\r\nb'), 'a\r\rb');
assert.strictEqual(normalizePasteText(''), '');
assert.strictEqual(normalizePasteText(null), '');

console.log('paste-core ok');
