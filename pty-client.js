// App side of pty-host.js. spawn() returns an object shaped like a node-pty
// IPty (write/resize/kill/onData/onExit/pid), so call sites don't change.
const net = require('net');
const crypto = require('crypto');
const { spawn: spawnProc } = require('child_process');
const { HOST_VERSION } = require('./pty-host');

function createPtyClient({ pipePath, launchHost }) {
  let sock = null;
  const procs = new Map(); // key -> proxy
  const waiting = new Map(); // reply type -> [resolve]

  const out = (msg) => { if (sock && !sock.destroyed) sock.write(JSON.stringify(msg) + '\n'); };
  const request = (msg, type) => new Promise((resolve) => {
    (waiting.get(type) || waiting.set(type, []).get(type)).push(resolve);
    out(msg);
  });

  function proxy(key, pid = 0) {
    const dataCbs = [], exitCbs = [];
    const p = {
      key, pid, _buf: '', _exit: null,
      write: (d) => out({ t: 'write', key, d }),
      resize: (cols, rows) => out({ t: 'resize', key, cols, rows }),
      kill: () => out({ t: 'kill', key }),
      // Output that arrives before a listener is attached is held, not dropped.
      onData: (cb) => { dataCbs.push(cb); if (p._buf) { const b = p._buf; p._buf = ''; cb(b); } },
      onExit: (cb) => { exitCbs.push(cb); if (p._exit) cb(p._exit); },
      _data: (d) => { if (dataCbs.length) dataCbs.forEach(cb => cb(d)); else p._buf += d; },
      _exited: (code) => { procs.delete(key); p._exit = { exitCode: code }; exitCbs.forEach(cb => cb(p._exit)); },
    };
    procs.set(key, p);
    return p;
  }

  function onMsg(msg) {
    const p = msg.key !== undefined ? procs.get(msg.key) : null;
    if (msg.t === 'data') { if (p) p._data(msg.d); return; }
    if (msg.t === 'exit') { if (p) p._exited(msg.code); return; }
    if (msg.t === 'spawned') { if (p) p.pid = msg.pid; return; }
    const q = waiting.get(msg.t);
    if (q && q.length) q.shift()(msg);
  }

  function tryConnect() {
    return new Promise((resolve, reject) => {
      const s = net.connect(pipePath);
      s.once('connect', () => { s.removeListener('error', reject); resolve(s); });
      s.once('error', reject);
    });
  }

  async function connect() {
    let s;
    try { s = await tryConnect(); } catch {
      launchHost();
      for (let i = 0; i < 50 && !s; i++) {
        await new Promise(r => setTimeout(r, 100));
        try { s = await tryConnect(); } catch {}
      }
      if (!s) throw new Error('pty host did not start');
    }
    sock = s;
    s.setEncoding('utf8');
    let pending = '';
    s.on('data', (chunk) => {
      pending += chunk;
      let nl;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl); pending = pending.slice(nl + 1);
        try { onMsg(JSON.parse(line)); } catch {}
      }
    });
    // Host died: every pty in it died too. Report them as crashed so auto-resume kicks in.
    s.on('close', () => { if (sock === s) sock = null; for (const p of [...procs.values()]) p._exited(1); });
    s.on('error', () => {});
    const hello = await request({ t: 'hello' }, 'hello');
    // A host left over from an older build, with nothing running in it: replace it.
    // With live agents it stays — they're worth more than the upgrade.
    if (hello.version !== HOST_VERSION && hello.count === 0) {
      out({ t: 'shutdown' });
      sock = null; s.destroy();
      await new Promise(r => setTimeout(r, 700));
      return connect();
    }
  }

  return {
    connect,
    get connected() { return !!sock; },
    spawn(file, args, opts) {
      const key = crypto.randomUUID();
      const p = proxy(key);
      out({ t: 'spawn', key, file, args, opts });
      return p;
    },
    list: () => request({ t: 'list' }, 'list').then(m => m.ptys),
    async attach(key) {
      const m = await request({ t: 'attach', key }, 'attached');
      if (m.gone) return null;
      const p = proxy(key, m.pid);
      p.replay = m.replay;
      return p;
    },
    kill: (key) => out({ t: 'kill', key }),
    shutdown: () => out({ t: 'shutdown' }),
  };
}

// Pipe name per state dir, so a sandboxed test instance gets its own host.
function pipePathFor(stateDir, platform = process.platform) {
  const h = crypto.createHash('sha1').update(stateDir.toLowerCase()).digest('hex').slice(0, 12);
  return platform === 'win32' ? `\\\\.\\pipe\\overlord-pty-${h}` : require('path').join(stateDir, 'pty.sock');
}

// The host runs under Electron's own binary in plain-Node mode: node-pty is built
// against Electron's ABI, so a system `node` couldn't load it.
function hostLauncher(hostScript, pipePath) {
  return () => spawnProc(process.execPath, [hostScript, pipePath], {
    detached: true, stdio: 'ignore', windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  }).unref();
}

module.exports = { createPtyClient, pipePathFor, hostLauncher };
