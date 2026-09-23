const test = require('node:test');
const assert = require('node:assert');
const { makeKey229Fix } = require('./key229');

function setup() {
  const sent = [];
  const textarea = { value: 'thi' };
  const fix = makeKey229Fix({ input: (d) => sent.push(d) }, textarea);
  const ev = (o) => ({ stopped: false, stopImmediatePropagation() { this.stopped = true; }, ...o });
  return { sent, textarea, fix, ev };
}

test('keyCode 229 key is sent at once and the textarea restored, so xterm\'s deferred diff sends nothing', () => {
  const { sent, textarea, fix, ev } = setup();
  fix.keydown({ keyCode: 229, isComposing: false });
  textarea.value = 'this'; // browser inserts the char
  const e = ev({ inputType: 'insertText', data: 's', isComposing: false });
  fix.input(e);
  assert.deepStrictEqual(sent, ['s']);
  assert.strictEqual(textarea.value, 'thi');
  assert.ok(e.stopped);
});

test('normal keys and IME composition are left to xterm', () => {
  const { sent, textarea, fix, ev } = setup();
  fix.keydown({ keyCode: 83, isComposing: false });
  fix.input(ev({ inputType: 'insertText', data: 's', isComposing: false }));
  fix.keydown({ keyCode: 229, isComposing: true });
  fix.input(ev({ inputType: 'insertText', data: 'x', isComposing: true }));
  fix.keydown({ keyCode: 229, isComposing: false });
  fix.input(ev({ inputType: 'deleteContentBackward', data: null, isComposing: false }));
  assert.deepStrictEqual(sent, []);
  assert.strictEqual(textarea.value, 'thi');
});
