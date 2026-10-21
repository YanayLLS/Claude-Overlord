const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const createDocs = require('./docs-main');

const tick = (ms) => new Promise(r => setTimeout(r, ms));
function harness(extra = {}) {
  const sent = [], settings = { docs: [] }, saves = { n: 0 }, ext = [];
  const docs = createDocs({
    send: (m) => sent.push(m), settings, saveState: () => { saves.n++; }, log: () => {},
    execPath: 'C:\\app\\Overlord.exe', appPath: 'C:\\app', isPackaged: true,
    showOpenDialog: async () => ({ canceled: true }), showItemInFolder: () => {}, openPath: async () => '', openExternal: async (u) => { ext.push(u); },
    platform: 'win32', ...extra,
  });
  return { docs, sent, settings, saves, ext };
}
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'overlord-docs-')); }

test('openPaths: reads in order, last one selected and on top, remembered in settings', async () => {
  const dir = tmpDir(); const a = path.join(dir, 'a.md'), b = path.join(dir, 'b.md');
  fs.writeFileSync(a, '# A'); fs.writeFileSync(b, '# B');
  const h = harness();
  await h.docs.openPaths([a, b, path.join(dir, 'c.txt')]);
  const opens = h.sent.filter(m => m.type === 'docOpen');
  assert.deepStrictEqual(opens.map(m => [path.basename(m.path), m.text, m.select]), [['a.md', '# A', false], ['b.md', '# B', true]]);
  assert.deepStrictEqual(h.settings.docs, [b, a]);
  assert.strictEqual(h.saves.n, 2);
  h.docs.dispose(); fs.rmSync(dir, { recursive: true, force: true });
});

test('restore: reads the saved list bottom-up so the saved top stays on top; missing files are dropped quietly', async () => {
  const dir = tmpDir(); const a = path.join(dir, 'a.md'), b = path.join(dir, 'b.md'), gone = path.join(dir, 'gone.md');
  fs.writeFileSync(a, 'A'); fs.writeFileSync(b, 'B');
  const h = harness(); h.settings.docs = [a, gone, b];
  await h.docs.restore();
  const opens = h.sent.filter(m => m.type === 'docOpen');
  assert.deepStrictEqual(opens.map(m => [path.basename(m.path), m.select]), [['b.md', false], ['a.md', false]]);
  assert.deepStrictEqual(h.settings.docs, [a, b]);
  assert.strictEqual(h.sent.some(m => m.type === 'toast'), false);
  h.docs.dispose(); fs.rmSync(dir, { recursive: true, force: true });
});

test('an explicit open of a missing file toasts instead of adding it', async () => {
  const h = harness();
  await h.docs.openPaths([path.join(tmpDir(), 'nope.md')]);
  assert.strictEqual(h.sent.filter(m => m.type === 'docOpen').length, 0);
  assert.match(h.sent.find(m => m.type === 'toast').text, /Could not open nope\.md: file not found/);
  assert.deepStrictEqual(h.settings.docs, []);
});

test('a watched file that changes on disk is re-sent; close stops that and forgets it', async () => {
  const dir = tmpDir(); const a = path.join(dir, 'a.md');
  fs.writeFileSync(a, 'v1');
  const h = harness();
  await h.docs.openPaths([a]);
  await tick(50);
  fs.writeFileSync(a, 'v2 is longer');
  let change; for (let i = 0; i < 40 && !change; i++) { await tick(50); change = h.sent.find(m => m.type === 'docChange'); }
  assert.ok(change, 'docChange arrived'); assert.strictEqual(change.text, 'v2 is longer');
  assert.strictEqual(h.docs.handle({ type: 'docClose', path: a }), true);
  assert.deepStrictEqual(h.settings.docs, []);
  assert.strictEqual(h.docs.isOpen(a), false);
  const n = h.sent.length;
  fs.writeFileSync(a, 'v3 after close'); await tick(400);
  assert.strictEqual(h.sent.length, n, 'nothing sent after close');
  h.docs.dispose(); fs.rmSync(dir, { recursive: true, force: true });
});

test('a watched file that is deleted is reported gone', async () => {
  const dir = tmpDir(); const a = path.join(dir, 'a.md');
  fs.writeFileSync(a, 'x');
  const h = harness();
  await h.docs.openPaths([a]); await tick(50);
  fs.unlinkSync(a);
  let gone; for (let i = 0; i < 40 && !gone; i++) { await tick(50); gone = h.sent.find(m => m.type === 'docGone'); }
  assert.ok(gone); assert.strictEqual(gone.path, a);
  h.docs.dispose(); fs.rmSync(dir, { recursive: true, force: true });
});

test('handle: unknown messages are not ours; docShown/docReveal/docOpenWith are', () => {
  const h = harness();
  assert.strictEqual(h.docs.handle({ type: 'focusAgent', id: 1 }), false);
  assert.strictEqual(h.docs.handle({ type: 'docShown', path: 'x.md', t0: Date.now() }), true);
  assert.strictEqual(h.docs.handle({ type: 'docReveal', path: 'C:\\x.md' }), true);
  assert.strictEqual(h.docs.handle({ type: 'docOpenWith', path: 'C:\\x.md' }), true);
});

function fakeReg(userChoice) {
  const calls = [];
  const execFile = (cmd, args, _o, cb) => {
    calls.push(args.join(' '));
    if (args[0] === 'query') return cb(userChoice ? null : new Error('not found'), userChoice ? `    ProgId    REG_SZ    ${userChoice}\n` : '');
    cb(null, 'The operation completed successfully.');
  };
  return { calls, execFile };
}

test('associate (packaged): registers the ProgID, open command, .md/.markdown and capabilities under HKCU', async () => {
  const r = fakeReg('');
  const h = harness({ execFile: r.execFile });
  const res = await h.docs._associate();
  assert.deepStrictEqual(res, { ok: true, needsPick: false });
  const joined = r.calls.join('\n');
  assert.match(joined, /add HKCU\\Software\\Classes\\Overlord\.Markdown\\shell\\open\\command \/ve \/d "C:\\app\\Overlord\.exe" "%1" \/f/);
  assert.match(joined, /add HKCU\\Software\\Classes\\\.md \/ve \/d Overlord\.Markdown \/f/);
  assert.match(joined, /add HKCU\\Software\\Classes\\\.markdown\\OpenWithProgids \/v Overlord\.Markdown/);
  assert.match(joined, /add HKCU\\Software\\RegisteredApplications \/v Overlord \/d Software\\Overlord\\Capabilities/);
  assert.ok(r.calls.every(c => !c.startsWith('add HKLM')), 'no machine-wide writes');
  assert.deepStrictEqual(h.ext, []);
});

test('associate (from source): the command runs electron with the app dir; an existing user choice opens Default apps', async () => {
  const r = fakeReg('VSCode.md');
  const h = harness({ execFile: r.execFile, isPackaged: false, execPath: 'D:\\w\\node_modules\\electron\\dist\\electron.exe', appPath: 'D:\\w' });
  const res = await h.docs._associate();
  assert.deepStrictEqual(res, { ok: true, needsPick: true, chosen: 'VSCode.md' });
  assert.ok(r.calls.some(c => c.includes('"D:\\w\\node_modules\\electron\\dist\\electron.exe" "D:\\w" "%1"')));
  assert.deepStrictEqual(h.ext, ['ms-settings:defaultapps?registeredAppUser=Overlord']);
});

test('associate: a failing reg write is reported, not thrown; other platforms decline', async () => {
  const h = harness({ execFile: (c, a, o, cb) => cb(new Error('ERROR: Access is denied.'), '') });
  const res = await h.docs._associate();
  assert.strictEqual(res.ok, false); assert.match(res.error, /Access is denied/);
  const mac = harness({ platform: 'darwin' });
  assert.strictEqual((await mac.docs._associate()).ok, false);
});

test('newNote: creates a dated file in the notes folder, opens it for editing, never clobbers', async () => {
  const dir = tmpDir(); const notes = path.join(dir, 'notes');
  const h = harness({ notesDir: notes });
  const a = await h.docs.newNote();
  assert.ok(a && a.startsWith(notes) && /^Note \d{4}-\d{2}-\d{2} \d{2}-\d{2}\.md$/.test(path.basename(a)), a);
  assert.strictEqual(fs.readFileSync(a, 'utf8'), '# Note\n\n');
  const open = h.sent.find(m => m.type === 'docOpen');
  assert.strictEqual(open.path, a); assert.strictEqual(open.select, true); assert.strictEqual(open.edit, true);
  const b = await h.docs.newNote();
  assert.notStrictEqual(a, b); assert.ok(/ \(2\)\.md$/.test(b), b);
  assert.strictEqual(await harness().docs.newNote(), null); // no notes folder configured
  h.docs.dispose(); fs.rmSync(dir, { recursive: true, force: true });
});
