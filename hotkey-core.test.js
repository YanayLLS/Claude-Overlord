const test = require('node:test');
const assert = require('node:assert');
const { hotkeyLetter } = require('./hotkey-core');

test('Latin layout: the typed letter, lower-cased', () => {
  assert.strictEqual(hotkeyLetter({ key: 'v', code: 'KeyV' }), 'v');
  assert.strictEqual(hotkeyLetter({ key: 'F', code: 'KeyF', shiftKey: true }), 'f');
});

test('Hebrew layout: Ctrl+V arrives as key ו — the physical key wins', () => {
  assert.strictEqual(hotkeyLetter({ key: 'ו', code: 'KeyV' }), 'v');
  assert.strictEqual(hotkeyLetter({ key: 'ב', code: 'KeyC' }), 'c');
});

test('Dvorak: key is a Latin letter at another physical position — the typed letter wins', () => {
  assert.strictEqual(hotkeyLetter({ key: 'v', code: 'Period' }), 'v');
});

test('non-letter keys fall back to key as typed', () => {
  assert.strictEqual(hotkeyLetter({ key: '/', code: 'Slash' }), '/');
  assert.strictEqual(hotkeyLetter({ key: 'Escape', code: 'Escape' }), 'escape');
  assert.strictEqual(hotkeyLetter({ key: '!', code: 'Digit1' }), '!');
  assert.strictEqual(hotkeyLetter({ key: undefined, code: undefined }), '');
});
