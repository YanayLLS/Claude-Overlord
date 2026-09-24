// Owns the agent terminals in a process of its own, so restarting Overlord
// doesn't kill the Claude sessions (and their subagents) running inside them.
// The app connects over a local pipe; when it goes away the ptys keep running
// and buffer their output, and the next app instance attaches and replays it.
//
// Protocol: newline-delimited JSON, one client at a time (a new connection
// replaces the old one — the old app is gone by then anyway).
//   client → host: hello | spawn{key,file,args,opts} | attach{key} | list |
//                  write{key,d} | resize{key,cols,rows} | kill{key} | shutdown
//   host → client: hello{version} | spawned{key,pid} | attached{key,pid,replay} |
//                  list{ptys} | data{key,d} | exit{key,code}
const net = require('net');
const fs = require('fs');

const HOST_VERSION = 1;
const REPLAY_MAX = 256 * 1024; // chars of output kept per pty for a reattaching app
const IDLE_EXIT_MS = 30 * 1000; // no ptys and no app → nothing to keep alive
// ponytail: after a close, agents that were mid-turn finish and then sit at their prompt
// until the app reopens (or reboot). Add a no-client timeout if that starts to cost memory.

function createHost({ pty, pipePath }) {
  const ptys = new Map(); // key -> { proc, buf }
  let client = null;
  let idleTimer = null;

  const out = (msg) => { if (client && !client.destroyed) client.write(JSON.stringify(msg) + '\n'); };

  function checkIdle() {
    clearTimeout(idleTimer);
    if (!client && ptys.size === 0) idleTimer = setTimeout(() => server.close(() => process.exit(0)), IDLE_EXIT_MS).unref(); // the listening pipe keeps the host alive, not this
  }

  function spawn({ key, file, args, opts }) {
    let proc;
    try { proc = pty.spawn(file, args, opts); } catch (e) {
      out({ t: 'data', key, d: `\r\n\x1b[31mFailed to start terminal: ${e.message}\x1b[0m\r\n` });
      return out({ t: 'exit', key, code: -1 });
    }
    const p = { proc, buf: '' };
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
      case 'hello': return out({ t: 'hello', version: HOST_VERSION, count: ptys.size });
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

  return { listen, stop, ptys };
}

module.exports = { createHost, HOST_VERSION };

if (require.main === module) {
  const host = createHost({ pty: require('node-pty'), pipePath: process.argv[2] });
  // Another host already owns the pipe (two app instances racing) — let it.
  host.listen().catch(() => process.exit(0));
}
