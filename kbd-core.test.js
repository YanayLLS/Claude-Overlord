const test = require('node:test');
const assert = require('node:assert');
const { hwndOf, cscPath, KBD_SRC, kbdExeName } = require('./kbd-core');

test('hwndOf: 64-bit handle buffer → decimal string', () => {
  const b = Buffer.alloc(8); b.writeBigUInt64LE(0x1234567890n);
  assert.strictEqual(hwndOf(b), String(0x1234567890));
});

test('hwndOf: 32-bit handle buffer', () => {
  const b = Buffer.alloc(4); b.writeUInt32LE(0xabcd);
  assert.strictEqual(hwndOf(b), String(0xabcd));
});

test('cscPath: Framework64 first, then Framework, null when neither', () => {
  const path = require('path');
  const w = 'C:\\Windows';
  const f64 = path.join(w, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), f32 = path.join(w, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe');
  assert.strictEqual(cscPath(w, p => p === f64 || p === f32), f64);
  assert.strictEqual(cscPath(w, p => p === f32), f32);
  assert.strictEqual(cscPath(w, () => false), null);
});

test('kbdExeName changes with the source so a stale helper is rebuilt', () => {
  assert.match(kbdExeName(), /^kbd-en-[0-9a-f]{8}\.exe$/);
  assert.match(KBD_SRC, /WM_INPUTLANGCHANGEREQUEST|0x0050/);
});
