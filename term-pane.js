// Terminals pane, main side. Dev scripts (start-full.bat and friends) used to `start` each server in its own
// console window, which popped over Overlord and stole focus. ovl-start.cmd sends them here instead: each
// becomes a named tab in the pane, its pty living in the pty host so the servers outlive an app restart.
//
// Wire: POST http://127.0.0.1:<port>/open  header x-ovl-token  body { name, cwd, mode, line, env }
//   same name again = replace (the old process is killed first, like the bats' close-by-title).
// The port and token sit in <stateDir>/term-pane.json; the helper scripts are copied to <stateDir>/bin.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { appendBuf, plainTail } = require('./term-pane-core');

// A bat an agent runs carries the agent's shell env. Claude Code sets NoDefaultCurrentDirectoryInExePath there,
// which stops cmd finding `dev.bat` in its own folder ("'dev.bat' is not recognized"); a console you open never has it.
const AGENT_ONLY = /^(NoDefaultCurrentDirectoryInExePath|CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID)$/i;
const tabEnv = (env) => Object.fromEntries(Object.entries(env || process.env).filter(([k]) => !AGENT_ONLY.test(k)));

// enabled(): the Terminals setting. Off = no port file, so ovl-start falls back to plain `start` windows.
function createTermPane({ stateDir, ptyFactory, ptyHost, send, log = () => {}, appDir = __dirname, enabled = () => true }) {
  const tabs = new Map(); // name -> { name, cwd, mode, line, env, proc, key, buf, running, code }
  const tabsFile = path.join(stateDir, 'term-tabs.json');
  const infoFile = path.join(stateDir, 'term-pane.json');
  const token = crypto.randomUUID();
  let server = null, size = { cols: 120, rows: 30 };

  const view = (t) => ({ name: t.name, cwd: t.cwd, line: t.line, running: t.running, code: t.code });
  const pushList = () => send({ type: 'tp:list', tabs: [...tabs.values()].map(view) });
  const save = () => {
    const rows = [...tabs.values()].map(t => ({ name: t.name, cwd: t.cwd, mode: t.mode, line: t.line, env: t.env, key: t.running ? t.key : null }));
    try { fs.writeFileSync(tabsFile, JSON.stringify(rows)); } catch (e) { log(`term-pane save failed: ${e.message}`); }
  };

  function wire(t, proc) {
    t.proc = proc; t.key = proc.key || null; t.running = true; t.code = null;
    proc.onData((d) => { t.buf = appendBuf(t.buf, d); send({ type: 'tp:data', name: t.name, d }); });
    proc.onExit((e) => {
      if (t.proc !== proc) return; // replaced: the new process owns the tab now
      t.running = false; t.code = e && e.exitCode; t.proc = null;
      save(); pushList();
    });
  }

  function spawn(t) {
    const comspec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
    // A string, not an array: node-pty hands it to CreateProcess as typed, so cmd sees the bat's own quoting.
    const proc = ptyFactory().spawn(comspec, `/d ${t.mode} ${t.line}`, { name: 'xterm-256color', cols: size.cols, rows: size.rows, cwd: t.cwd, env: tabEnv(t.env) });
    wire(t, proc);
  }

  function kill(t) { if (t.proc && t.running) { try { t.proc.kill(); } catch {} } t.proc = null; t.running = false; }

  function open({ name, cwd, mode = '/k', line, env }) {
    if (!name || !line) throw new Error('name and line are required');
    if (!cwd || !fs.existsSync(cwd)) throw new Error(`folder not found: ${cwd}`);
    const old = tabs.get(name);
    if (old) kill(old);
    const t = { name, cwd, mode: mode === '/c' ? '/c' : '/k', line, env: env || process.env, buf: '' };
    tabs.set(name, t);
    spawn(t);
    save(); pushList();
    send({ type: 'tp:opened', name });
    log(`term-pane opened "${name}" in ${cwd}: ${line}`);
  }

  function handle(msg) {
    const t = msg.name != null ? tabs.get(msg.name) : null;
    switch (msg.type) {
      case 'tp:sync': pushList(); for (const x of tabs.values()) if (x.buf) send({ type: 'tp:data', name: x.name, d: x.buf, replay: true }); return;
      case 'tp:input': if (t && t.proc && t.running) t.proc.write(msg.d); return;
      case 'tp:resize':
        if (msg.cols > 0 && msg.rows > 0) { size = { cols: msg.cols, rows: msg.rows }; for (const x of tabs.values()) if (x.proc && x.running) try { x.proc.resize(msg.cols, msg.rows); } catch {} }
        return;
      case 'tp:restart': if (t) { kill(t); t.buf = ''; spawn(t); save(); pushList(); } return;
      case 'tp:stop': if (t) { kill(t); save(); pushList(); } return;
      case 'tp:close': if (t) { kill(t); tabs.delete(msg.name); save(); pushList(); } return;
    }
  }

  // Tabs from before an app restart: their ptys are still running in the pty host — attach, else show them stopped.
  async function restore() {
    let rows = [];
    try { rows = JSON.parse(fs.readFileSync(tabsFile, 'utf8')); } catch { return; }
    for (const r of rows) {
      const t = { ...r, buf: '', running: false, code: null, proc: null };
      tabs.set(r.name, t);
      if (!r.key || !ptyHost || !ptyHost.connected) continue;
      try {
        const proc = await ptyHost.attach(r.key);
        if (proc) { t.buf = appendBuf('', proc.replay || ''); wire(t, proc); }
      } catch {}
    }
    pushList();
  }

  function installHelpers() {
    const bin = path.join(stateDir, 'bin');
    try {
      fs.mkdirSync(bin, { recursive: true });
      // Read from the app (inside app.asar when packaged), written out where a plain node can run them.
      for (const f of ['bin/ovl-start.cmd', 'bin/ovl-start.js', 'term-pane-core.js']) fs.writeFileSync(path.join(bin, path.basename(f)), fs.readFileSync(path.join(appDir, f)));
    } catch (e) { log(`term-pane helpers not installed: ${e.message}`); }
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 4 * 1024 * 1024) { reject(new Error('too large')); req.destroy(); } });
      req.on('end', () => resolve(raw));
      req.on('error', reject);
    });
  }

  async function onRequest(req, res) {
    const reply = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    // The token is what keeps a web page from POSTing commands to localhost (it can't read the state file).
    if (req.headers['x-ovl-token'] !== token) return reply(403, { error: 'bad token' });
    if (req.method !== 'POST' || req.url !== '/open') return reply(404, { error: 'not found' });
    try { open(JSON.parse(await readBody(req))); reply(200, { ok: true }); }
    catch (e) { reply(400, { error: e.message }); }
  }

  async function start() {
    installHelpers();
    await restore();
    server = http.createServer((req, res) => { onRequest(req, res).catch(() => { try { res.writeHead(500); res.end(); } catch {} }); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    sync();
  }

  // Publish or withdraw the port file to match the setting (call after it changes).
  function sync() {
    if (!server) return;
    if (enabled()) fs.writeFileSync(infoFile, JSON.stringify({ port: server.address().port, token, pid: process.pid }));
    else try { fs.unlinkSync(infoFile); } catch {}
  }

  // Quit leaves the servers running in the pty host (an update restart must not drop the dev stack).
  function stop() {
    save();
    try { fs.unlinkSync(infoFile); } catch {}
    if (server) server.close();
  }

  // For agents (MCP terminal_* tools): what's running, and what it printed.
  const need = (name) => { const t = tabs.get(name); if (!t) throw new Error(`No terminal "${name}". Open ones: ${[...tabs.keys()].join(', ') || 'none'}`); return t; };
  const api = {
    list: () => [...tabs.values()].map(t => `${t.name} — ${t.running ? 'running' : `stopped${t.code != null ? ` (exit ${t.code})` : ''}`} — ${t.cwd} — ${t.line}`).join('\n') || 'No terminals open.',
    read: (name, opts) => plainTail(need(name).buf, opts) || '(no output yet)',
    restart: (name) => { handle({ type: 'tp:restart', name: need(name).name }); return `Restarted "${name}".`; },
  };

  return { start, stop, handle, open, sync, tabs, api };
}

// The pty-host keys the pane owns, so the startup sweep of orphan agent ptys leaves the dev servers alone.
function termPaneKeys(stateDir) {
  try { return new Set(JSON.parse(fs.readFileSync(path.join(stateDir, 'term-tabs.json'), 'utf8')).map(r => r.key).filter(Boolean)); } catch { return new Set(); }
}

module.exports = { createTermPane, termPaneKeys };
