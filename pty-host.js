// Owns the agent terminals in a process of its own, so restarting Overlord
// doesn't kill the Claude sessions (and their subagents) running inside them.
// The app connects over a local pipe; when it goes away the ptys keep running
// and buffer their output, and the next app instance attaches and replays it.
//
// Protocol: newline-delimited JSON, one client at a time (a new connection
// replaces the old one — the old app is gone by then anyway).
//   client → host: hello | spawn{key,file,args,opts} | attach{key} | list |
//                  write{key,d} | resize{key,cols,rows} | kill{key} | shutdown
//   host → client: hello{version,count,pid} | spawned{key,pid} | attached{key,pid,replay} |
//                  list{ptys} | data{key,d} | exit{key,code}
const net = require('net');
const fs = require('fs');

const HOST_VERSION = 1;
const REPLAY_MAX = 256 * 1024; // chars of output kept per pty for a reattaching app
const IDLE_EXIT_MS = 30 * 1000; // no ptys and no app → nothing to keep alive
// ponytail: after a close, agents that were mid-turn finish and then sit at their prompt
// until the app reopens (or reboot). Add a no-client timeout if that starts to cost memory.

// node-pty on Windows never closes the pseudo console of a pty that exits on its own: conpty.cc
// drops its handle-table entry before the JS exit callback runs, so kill() afterwards is a no-op
// and ClosePseudoConsole never happens. Every natural exit therefore leaves a headless conhost.exe
// (~8 MB) and node-pty's conout worker isolate (~10 MB) behind for the host's whole life — a host
// with 4 live ptys was carrying 13 stray conhosts. The reaper below kills the conhosts no live pty
// can own: a conhost is born inside the synchronous pty.spawn, so one whose creation time falls
// outside every live pty's spawn window (± ATTR_SLACK_MS) belongs to a dead one.
const ATTR_SLACK_MS = 250;
const REAP_AFTER_EXIT_MS = 2000; // past node-pty's own 1 s flush-and-cleanup
const REAP_EVERY_MS = 10 * 60 * 1000;
const CONHOST_MIN_AGE_MS = 10 * 1000; // a brand-new conhost's pty may still be registering
function createReaper({ listConhosts, kill, now = Date.now, live }) {
  let busy = false;
  return async function reap() {
    if (busy) return [];
    busy = true;
    const killed = [];
    try {
      const windows = live().map(p => [p.spawnedAt - ATTR_SLACK_MS, p.spawnedDoneAt + ATTR_SLACK_MS]);
      for (const c of await listConhosts()) {
        if (now() - c.createdAt < CONHOST_MIN_AGE_MS) continue;
        if (windows.some(([a, b]) => c.createdAt >= a && c.createdAt <= b)) continue;
        try { kill(c.pid); killed.push(c.pid); } catch {}
      }
    } catch {}
    busy = false;
    return killed;
  };
}
// Headless conhost children of this process: [{ pid, createdAt }]. One PowerShell call (~0.3 s, async).
function listConhostsWin32() {
  return new Promise((resolve) => {
    const script = `Get-CimInstance Win32_Process -Filter "Name='conhost.exe' AND ParentProcessId=${process.pid}" | ForEach-Object { "$($_.ProcessId) $(([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()) $($_.CommandLine)" }`;
    require('child_process').execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(String(stdout).split('\n').map(l => l.trim().match(/^(\d+) (\d+) (.*)$/)).filter(m => m && /--headless/.test(m[3])).map(m => ({ pid: +m[1], createdAt: +m[2] })));
    });
  });
}

function createHost({ pty, pipePath, listConhosts = null, killPid = (pid) => process.kill(pid) }) {
  const ptys = new Map(); // key -> { proc, buf, spawnedAt, spawnedDoneAt }
  let client = null;
  let idleTimer = null;
  const reap = listConhosts ? createReaper({ listConhosts, kill: killPid, live: () => [...ptys.values()] }) : async () => [];
  if (listConhosts) setInterval(reap, REAP_EVERY_MS).unref();

  const out = (msg) => { if (client && !client.destroyed) client.write(JSON.stringify(msg) + '\n'); };

  function checkIdle() {
    clearTimeout(idleTimer);
    if (!client && ptys.size === 0) idleTimer = setTimeout(() => server.close(() => process.exit(0)), IDLE_EXIT_MS).unref(); // the listening pipe keeps the host alive, not this
  }

  function spawn({ key, file, args, opts }) {
    let proc;
    const spawnedAt = Date.now();
    try { proc = pty.spawn(file, args, opts); } catch (e) {
      out({ t: 'data', key, d: `\r\n\x1b[31mFailed to start terminal: ${e.message}\x1b[0m\r\n` });
      return out({ t: 'exit', key, code: -1 });
    }
    const p = { proc, buf: '', spawnedAt, spawnedDoneAt: Date.now() };
    ptys.set(key, p);
    proc.onData((d) => {
      p.buf += d;
      if (p.buf.length > REPLAY_MAX) p.buf = p.buf.slice(-REPLAY_MAX);
      out({ t: 'data', key, d });
    });
    proc.onExit((e) => {
      p.exited = true;
      ptys.delete(key);
      out({ t: 'exit', key, code: e && e.exitCode });
      checkIdle();
      // What node-pty leaves behind on a natural exit (see the reaper note above).
      setTimeout(() => { try { proc._agent?._conoutSocketWorker?.dispose?.(); } catch {} reap(); }, REAP_AFTER_EXIT_MS).unref();
    });
    out({ t: 'spawned', key, pid: proc.pid });
  }

  // node-pty on Windows corrupts the heap if a pty is killed twice or after exit.
  function kill(p) {
    if (!p || p.exited || p.killed) return;
    p.killed = true;
    try { p.proc.kill(); } catch {}
  }

  function handle(msg) {
    const p = ptys.get(msg.key);
    switch (msg.t) {
      case 'hello': return out({ t: 'hello', version: HOST_VERSION, count: ptys.size, pid: process.pid });
      case 'spawn': return spawn(msg);
      case 'attach': return out(p ? { t: 'attached', key: msg.key, pid: p.proc.pid, replay: p.buf } : { t: 'attached', key: msg.key, gone: true });
      case 'list': return out({ t: 'list', ptys: [...ptys].map(([key, x]) => ({ key, pid: x.proc.pid })) });
      case 'write': if (p && !p.exited) try { p.proc.write(msg.d); } catch {} return;
      case 'resize': if (p && !p.exited) try { p.proc.resize(msg.cols, msg.rows); } catch {} return;
      case 'kill': return kill(p);
      case 'shutdown':
        for (const x of ptys.values()) kill(x);
        return setTimeout(() => process.exit(0), 500); // let the kills land
    }
  }

  const server = net.createServer((sock) => {
    if (client) client.destroy();
    client = sock;
    clearTimeout(idleTimer);
    sock.setEncoding('utf8');
    let pending = '';
    sock.on('data', (chunk) => {
      pending += chunk;
      let nl;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl); pending = pending.slice(nl + 1);
        try { handle(JSON.parse(line)); } catch {}
      }
    });
    const drop = () => { if (client === sock) { client = null; checkIdle(); } };
    sock.on('close', drop);
    sock.on('error', drop);
  });

  function listen() {
    return new Promise((resolve, reject) => {
      if (process.platform !== 'win32') { try { fs.unlinkSync(pipePath); } catch {} } // stale socket from a killed host
      server.once('error', reject);
      server.listen(pipePath, () => { checkIdle(); resolve(); });
    });
  }

  const stop = () => { clearTimeout(idleTimer); if (client) client.destroy(); server.close(); };

  return { listen, stop, ptys, reap };
}

module.exports = { createHost, createReaper, listConhostsWin32, HOST_VERSION, ATTR_SLACK_MS, CONHOST_MIN_AGE_MS };

if (require.main === module) {
  const host = createHost({ pty: require('node-pty'), pipePath: process.argv[2], listConhosts: process.platform === 'win32' ? listConhostsWin32 : null });
  // Another host already owns the pipe (two app instances racing) — let it.
  host.listen().catch(() => process.exit(0));
}
