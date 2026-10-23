const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const { createHost } = require('./pty-host');
const { createPtyClient, pipePathFor, waitGone } = require('./pty-client');

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
  assert.strictEqual(a.hostPid, process.pid, 'the host says its pid, so an update can wait for it to exit');
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

test('waitGone: resolves when the process exits, kills it past the deadline', async () => {
  let alive = 3;
  assert.strictEqual(await waitGone(1, 5000, { alive: () => alive-- > 0, kill: () => { throw new Error('no kill needed'); } }), true);
  let killed = null;
  assert.strictEqual(await waitGone(7, 150, { alive: () => killed === null, kill: (p) => { killed = p; } }), false);
  assert.strictEqual(killed, 7);
});

// A conhost is born inside the synchronous pty.spawn, so its creation time sits inside that
// pty's [spawnedAt, spawnedDoneAt] window; anything outside every live window is a leak.
test('reaper kills only the headless conhosts no live pty can own', async () => {
  const { createReaper, ATTR_SLACK_MS, CONHOST_MIN_AGE_MS } = require('./pty-host');
  const T = 1_000_000, now = () => T + 60_000;
  const live = () => [{ spawnedAt: T, spawnedDoneAt: T + 400 }];
  const conhosts = [
    { pid: 1, createdAt: T + 100 },                      // the live pty's own
    { pid: 2, createdAt: T + 400 + ATTR_SLACK_MS },      // edge of the window: still the live pty's
    { pid: 3, createdAt: T - 5000 },                     // a pty that exited earlier → leak
    { pid: 4, createdAt: now() - CONHOST_MIN_AGE_MS + 1 }, // too young to judge
  ];
  const killed = [];
  const reap = createReaper({ listConhosts: async () => conhosts, kill: (pid) => killed.push(pid), now, live });
  assert.deepStrictEqual(await reap(), [3]);
  assert.deepStrictEqual(killed, [3]);
  // a kill that throws (already gone) doesn't stop the sweep
  const reap2 = createReaper({ listConhosts: async () => [{ pid: 5, createdAt: T - 9000 }, { pid: 6, createdAt: T - 8000 }], kill: (pid) => { if (pid === 5) throw new Error('gone'); killed.push(pid); }, now, live });
  assert.deepStrictEqual(await reap2(), [6]);
});

test('host stamps each pty with its spawn window and reaps with the live set', async () => {
  const pipePath = pipePathFor(path.join(os.tmpdir(), 'ov-pty-reap-' + process.pid));
  const pty = fakePty();
  const seen = [], killed = [];
  const host = createHost({ pty, pipePath, listConhosts: async () => seen, killPid: (pid) => killed.push(pid) });
  await host.listen();
  const c = createPtyClient({ pipePath, launchHost: () => { throw new Error('up'); } });
  await c.connect();
  const before = Date.now();
  const proc = c.spawn('cmd.exe', '/c claude', { cols: 80, rows: 24 });
  await tick();
  const p = host.ptys.get(proc.key);
  assert.ok(p.spawnedAt >= before && p.spawnedDoneAt >= p.spawnedAt);
  seen.push({ pid: 11, createdAt: p.spawnedAt - 60_000 }, { pid: 12, createdAt: p.spawnedAt });
  assert.deepStrictEqual(await host.reap(), [11]);
  host.stop();
});

// The host outlives the app, so a host fix only lands once the old host is gone. With agents in it the old one
// stays; the moment it's empty the client swaps in the current build.
test('a stale host with live ptys is kept, then replaced once it is empty', async () => {
  const { HOST_VERSION } = require('./pty-host');
  const pipePath = pipePathFor(path.join(os.tmpdir(), 'ov-pty-stale-' + process.pid));
  const pty = fakePty();
  const old = createHost({ pty, pipePath, version: HOST_VERSION - 1 });
  await old.listen();
  const seed = createPtyClient({ pipePath, launchHost: () => { throw new Error('up'); }, hostVersion: HOST_VERSION - 1 }); // the older build's own app
  await seed.connect();
  const proc = seed.spawn('cmd.exe', '/c claude', { cols: 80, rows: 24 }); // an agent lives in the old host
  await tick();
  let launched = 0;
  const fresh = createHost({ pty: fakePty(), pipePath });
  const c = createPtyClient({ pipePath, launchHost: () => { launched++; fresh.listen(); } });
  const origExit = process.exit; process.exit = () => {}; // the old host's shutdown would end the test runner
  try {
    await c.connect();
    assert.strictEqual(c.stale, true, 'older host, but it holds an agent: stays');
    assert.strictEqual(await c.upgradeIfEmpty(), false);
    assert.strictEqual(launched, 0);
    c.kill(proc.key); await tick();
    assert.strictEqual(await c.upgradeIfEmpty(), true, 'empty now: replaced');
    assert.strictEqual(launched, 1);
    assert.strictEqual(c.stale, false);
    assert.strictEqual(await c.upgradeIfEmpty(), false, 'nothing left to do');
  } finally { process.exit = origExit; old.stop(); fresh.stop(); }
});
