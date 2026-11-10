const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { createTermPane, termPaneKeys } = require('./term-pane');

function fakePty() {
  const spawned = [];
  let n = 0;
  return {
    spawned,
    factory: () => ({
      spawn(file, args, opts) {
        const p = { key: 'k' + (++n), file, args, opts, killed: false, written: '', dataCb: null, exitCb: null,
          onData(cb) { p.dataCb = cb; }, onExit(cb) { p.exitCb = cb; }, write(d) { p.written += d; }, resize() {}, kill() { p.killed = true; } };
        spawned.push(p);
        return p;
      },
    }),
  };
}

test('ovl-start opens a tab over HTTP; same title replaces it; the key is kept for the restart sweep', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-'));
  const sent = [], pty = fakePty();
  const pane = createTermPane({ stateDir: dir, ptyFactory: pty.factory, ptyHost: null, send: (m) => sent.push(m) });
  await pane.start();
  try {
    const helper = path.join(dir, 'bin', 'ovl-start.js');
    assert.ok(fs.existsSync(helper), 'helper copied to <stateDir>/bin');
    const run = (args) => new Promise((resolve) => execFile(process.execPath, [helper, ...args], { env: { ...process.env, OVERLORD_STATE_DIR: dir, MY_VAR: 'x1' } }, (e) => resolve(e ? e.code : 0)));

    assert.strictEqual(await run(['FL AI Chat', '/D', dir, 'cmd', '/k', 'npm run dev']), 0);
    assert.strictEqual(pty.spawned.length, 1);
    assert.match(pty.spawned[0].args, /^\/d \/k "npm run dev"$/);
    assert.strictEqual(pty.spawned[0].opts.cwd, dir);
    assert.strictEqual(pty.spawned[0].opts.env.MY_VAR, 'x1', 'the bat\'s environment reaches the server');
    assert.ok(!('NoDefaultCurrentDirectoryInExePath' in pty.spawned[0].opts.env), 'agent-shell vars dropped: cmd must find dev.bat in its folder');
    assert.deepStrictEqual([...termPaneKeys(dir)], ['k1']);

    pty.spawned[0].dataCb('hello');
    assert.ok(sent.some(m => m.type === 'tp:data' && m.d === 'hello'));

    assert.strictEqual(await run(['FL AI Chat', '/D', dir, 'cmd', '/k', 'npm run dev']), 0);
    assert.strictEqual(pty.spawned[0].killed, true, 'old process killed on replace');
    assert.strictEqual(pane.tabs.size, 1);
    pty.spawned[0].exitCb({ exitCode: 1 }); // late exit of the replaced one must not mark the new tab stopped
    assert.strictEqual(pane.tabs.get('FL AI Chat').running, true);

    assert.notStrictEqual(await run(['T', '/D', path.join(dir, 'nope'), 'cmd', '/k', 'x']), 0, 'bad folder → caller falls back to start');

    pane.handle({ type: 'tp:close', name: 'FL AI Chat' });
    assert.strictEqual(pane.tabs.size, 0);
    assert.strictEqual(pty.spawned[1].killed, true);
  } finally { pane.stop(); }
  assert.ok(!fs.existsSync(path.join(dir, 'term-pane.json')), 'no stale port file after stop');
});

test('a request without the token is refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-'));
  const pane = createTermPane({ stateDir: dir, ptyFactory: fakePty().factory, ptyHost: null, send: () => {} });
  await pane.start();
  try {
    const { port } = JSON.parse(fs.readFileSync(path.join(dir, 'term-pane.json'), 'utf8'));
    const res = await fetch(`http://127.0.0.1:${port}/open`, { method: 'POST', body: JSON.stringify({ name: 'x', cwd: dir, line: 'calc' }) });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(pane.tabs.size, 0);
  } finally { pane.stop(); }
});
