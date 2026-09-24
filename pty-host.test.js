const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const { createHost } = require('./pty-host');
const { createPtyClient, pipePathFor } = require('./pty-client');

// Echoes writes back as output, like a terminal would.
function fakePty() {
  const spawned = [];
  return {
    spawned,
    spawn(file, args) {
      const data = [], exit = [];
      const p = {
        pid: 4242, file, args, killed: false,
        onData: (cb) => data.push(cb), onExit: (cb) => exit.push(cb),
        write: (d) => data.forEach(cb => cb('echo:' + d)),
        resize: (c, r) => { p.size = [c, r]; },
        kill: () => { p.killed = true; exit.forEach(cb => cb({ exitCode: 0 })); },
        emit: (d) => data.forEach(cb => cb(d)),
      };
      spawned.push(p);
      return p;
    },
  };
}

const tick = (ms = 50) => new Promise(r => setTimeout(r, ms));

test('ptys outlive the app connection and replay to the next one', async () => {
  const pipePath = pipePathFor(path.join(os.tmpdir(), 'ov-pty-test-' + process.pid));
  const pty = fakePty();
  const host = createHost({ pty, pipePath });
  await host.listen();
  const noLaunch = () => { throw new Error('host should already be up'); };

  // First app instance: spawn, see output, send input.
  const a = createPtyClient({ pipePath, launchHost: noLaunch });
  await a.connect();
  const proc = a.spawn('cmd.exe', '/c claude', { cols: 80, rows: 24 });
  const got = [];
  proc.onData(d => got.push(d));
  await tick();
  assert.strictEqual(proc.pid, 4242);
  pty.spawned[0].emit('hello ');
  proc.write('x');
  await tick();
  assert.deepStrictEqual(got, ['hello ', 'echo:x']);

  // "Restart": second app instance takes over; the pty keeps running meanwhile.
  const b = createPtyClient({ pipePath, launchHost: noLaunch });
  await b.connect();
  pty.spawned[0].emit('while-away');
  await tick();
  assert.deepStrictEqual((await b.list()).map(x => x.key), [proc.key]);
  const again = await b.attach(proc.key);
  assert.strictEqual(again.replay, 'hello echo:xwhile-away');
  assert.strictEqual(pty.spawned[0].killed, false);

  const more = [];
  again.onData(d => more.push(d));
  again.resize(100, 30);
  again.write('y');
  await tick();
  assert.deepStrictEqual(pty.spawned[0].size, [100, 30]);
  assert.deepStrictEqual(more, ['echo:y']);

  let exited = null;
  again.onExit(e => { exited = e; });
  again.kill();
  await tick();
  assert.deepStrictEqual(exited, { exitCode: 0 });
  assert.strictEqual(await b.attach(proc.key), null);
  assert.deepStrictEqual(await b.list(), []);

  host.stop();
});
