const { app, BrowserWindow, ipcMain, dialog, shell, Notification, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { spawn, exec, execSync } = require('child_process');
const { autoUpdater } = require('electron-updater');
const pty = require('node-pty');
const wt = require('./worktree');
const pc = require('./peer-core');


// ── Constants ──────────────────────────────────────────
const JSONL_POLL_MS = 1000;
const TOOL_DONE_DELAY_MS = 300;
const PERMISSION_TIMER_MS = 7000;
// TEXT_IDLE_DELAY_MS removed — turn_duration is the authoritative "done" signal
const PREVIEW_MAX = 200;
const PROMPT_HISTORY_MAX = 50;
const PROMPT_BRIEF_MAX = 150;
const TITLE_MODEL = 'claude-haiku-4-5-20251001';
const TITLE_REGEN_TURNS = 3;
// Tools that don't imply the agent is blocked waiting on the user, so they don't
// trigger the permission timer. AskUserQuestion is NOT here: it blocks on the user,
// so it should surface as "needs you" (permission) rather than stay 'active'.
const EXEMPT = new Set(['Task', 'Agent', 'CronCreate', 'CronDelete', 'CronList']);
const SPINNER_DEBOUNCE_MS = 150;
const MAX_CRASH_RETRIES = 3;
const CRASH_RESUME_DELAY_MS = 2000;
// Watchdog: an 'active' agent whose transcript hasn't grown in this long, with no
// tool pending, has really finished — flip it to 'waiting' even if we never saw a
// turn_duration event (e.g. terminal detached, or the process died at the prompt).
const STATUS_STUCK_MS = 90000;
const USAGE_POLL_MS = 60000;
const USAGE_TIMEOUT_MS = 15000;
const USAGE_STALE_MS = 60 * 60 * 1000; // 1 hour — fetch even when idle if data older than this
const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const TEAM_POLL_MS = 3000;
const TEAMS_DIR = path.join(os.homedir(), '.claude', 'teams');
const TASKS_DIR = path.join(os.homedir(), '.claude', 'tasks');
const SERVER_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})\b[^\s)>\]'"]*/g;

const AGENT_NAMES = [
  'Ada', 'Atlas', 'Blake', 'Cairo', 'Cleo', 'Dash', 'Eden', 'Felix',
  'Gaia', 'Halo', 'Iris', 'Jade', 'Kai', 'Leo', 'Luna', 'Max',
  'Noel', 'Nova', 'Onyx', 'Pax', 'Quinn', 'Ravi', 'Rex', 'Rio',
  'Ruby', 'Sage', 'Sky', 'Sol', 'Tara', 'Uri', 'Vale', 'Wren',
  'Zara', 'Ash', 'Bay', 'Cass', 'Dex', 'Echo', 'Fern', 'Gray',
  'Hart', 'Ivy', 'Juno', 'Kit', 'Lark', 'Mars', 'Neve', 'Oak',
  'Pearl', 'Rune', 'Storm', 'Thorn', 'Vex', 'Wolf', 'Yara', 'Zen',
  'Amber', 'Briar', 'Cedar', 'Drift', 'Ember', 'Flint', 'Glen', 'Hawk',
  'Jet', 'Koda', 'Lynx', 'Mika', 'Nash', 'Opal', 'Pike',
  'Rain', 'Slate', 'Teal', 'Vega', 'Wilde', 'Xen', 'Zephyr',
];

// ── Auto-updater ──────────────────────────────────────────
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('update-available', info => {
  logToRenderer(`Update available: v${info.version}`);
  send({ type: 'updateAvailable', version: info.version });
});

autoUpdater.on('update-downloaded', info => {
  logToRenderer(`Update downloaded: v${info.version} — ready to install`);
  send({ type: 'updateDownloaded', version: info.version });
});

autoUpdater.on('error', err => {
  logToRenderer(`Auto-updater error: ${err.message}`);
});

// ── Git self-update (source checkouts) ────────────────
// Packaged builds update through electron-updater above. People who run the
// repo directly via start.bat get nothing from that, so offer them a pull.
const { pullBlocker, needsInstall } = require('./update-core');
const { pickResumedFile } = require('./resume-core');
const APP_DIR = __dirname;
let gitUpdateBusy = false;

function gitCmd(args, timeout = 30000) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: APP_DIR, timeout, windowsHide: true, shell: process.platform === 'win32' },
      (err, stdout, stderr) => resolve({
        ok: !err,
        out: String(stdout || '').trim(),
        err: String(stderr || err && err.message || '').trim(),
      }));
  });
}

function isGitCheckout() {
  if (app.isPackaged) return false; // packaged builds use electron-updater
  try { return fs.existsSync(path.join(APP_DIR, '.git')); } catch { return false; }
}

// Fetch master and report how far behind/ahead we are. Never mutates the tree.
async function checkGitUpdate() {
  if (!isGitCheckout() || gitUpdateBusy) return;
  const f = await gitCmd(['fetch', 'origin', 'master', '--quiet']);
  if (!f.ok) return; // offline or no remote — stay quiet, try again next tick
  const behind = await gitCmd(['rev-list', '--count', 'HEAD..origin/master']);
  const ahead = await gitCmd(['rev-list', '--count', 'origin/master..HEAD']);
  if (!behind.ok || !ahead.ok) return;
  send({
    type: 'gitUpdate',
    behind: Number(behind.out) || 0,
    ahead: Number(ahead.out) || 0,
  });
}

// Fast-forward only: it either applies cleanly or refuses, and can never leave
// a half-merged tree with conflict markers for the user to discover later.
async function doGitPull() {
  if (!isGitCheckout()) return;
  if (gitUpdateBusy) return;
  gitUpdateBusy = true;
  const fail = (m) => { gitUpdateBusy = false; send({ type: 'gitUpdateResult', ok: false, error: m }); };
  try {
    const status = await gitCmd(['status', '--porcelain']);
    if (!status.ok) return fail('Could not read git status: ' + status.err);
    const ahead = await gitCmd(['rev-list', '--count', 'origin/master..HEAD']);
    const blocked = pullBlocker({ porcelain: status.out, ahead: Number(ahead.out) || 0 });
    if (blocked) return fail(blocked);

    const before = await gitCmd(['rev-parse', 'HEAD']);
    send({ type: 'gitUpdateProgress', text: 'Pulling…' });
    const merge = await gitCmd(['merge', '--ff-only', 'origin/master']);
    if (!merge.ok) {
      return fail('Pull failed (not a fast-forward). Resolve it manually:\n' + (merge.err || merge.out).slice(0, 300));
    }
    const after = await gitCmd(['rev-parse', 'HEAD']);
    if (before.out === after.out) return fail('Already up to date.');

    const changed = await gitCmd(['diff', '--name-only', before.out, after.out]);
    if (changed.ok && needsInstall(changed.out.split('\n'))) {
      send({ type: 'gitUpdateProgress', text: 'Installing dependencies…' });
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const install = await new Promise((resolve) => {
        execFile(npm, ['install'], { cwd: APP_DIR, timeout: 300000, windowsHide: true, shell: process.platform === 'win32' },
          (err, so, se) => resolve({ ok: !err, err: String(se || err && err.message || '') }));
      });
      if (!install.ok) {
        // The code is already updated, so don't pretend nothing happened — tell
        // them exactly what to run before restarting.
        return fail('Updated, but npm install failed. Run it manually, then restart.\n' + install.err.slice(0, 300));
      }
    }
    send({ type: 'gitUpdateProgress', text: 'Restarting…' });
    // before-quit already hands running agents to detached processes that the
    // next launch reattaches, so a relaunch is a supported path, not a kill.
    setTimeout(() => { app.relaunch(); app.quit(); }, 400);
  } catch (e) {
    fail(e.message);
  }
}

function pickAgentName() {
  const used = new Set();
  for (const [, a] of agents) if (a.agentName) used.add(a.agentName);
  const avail = AGENT_NAMES.filter(n => !used.has(n));
  if (avail.length > 0) return avail[Math.floor(Math.random() * avail.length)];
  // All names used — pick a random name with numeric suffix
  const base = AGENT_NAMES[Math.floor(Math.random() * AGENT_NAMES.length)];
  for (let i = 2; ; i++) { const name = base + i; if (!used.has(name)) return name; }
}

// Model family detection for cost tracking (pricing computed in renderer)
function modelFamily(model) {
  if (!model) return 'sonnet';
  if (model.includes('fable')) return 'fable';
  if (model.includes('opus')) return 'opus';
  if (model.includes('haiku')) return 'haiku';
  return 'sonnet';
}

// Credentials for api.anthropic.com: an API key if one is exported, otherwise
// the OAuth token Claude Code's /login already wrote to disk. OAuth goes on
// Authorization: Bearer with its own beta header — not x-api-key.
// ponytail: no refresh-token flow — Claude Code refreshes on its own use, and
// this only needs a read-only GET. Add one if the "expired" path ever nags.
function anthropicAuthHeaders() {
  const base = { 'anthropic-version': '2023-06-01' };
  if (process.env.ANTHROPIC_API_KEY) return { ...base, 'x-api-key': process.env.ANTHROPIC_API_KEY };
  let oauth;
  try {
    oauth = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8')).claudeAiOauth;
  } catch { return null; }
  if (!oauth || !oauth.accessToken) return null;
  if (oauth.expiresAt && oauth.expiresAt < Date.now()) return null;
  return { ...base, 'authorization': `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' };
}

// The model picker is this list, nothing else — no hardcoded models, so one
// Anthropic ships tomorrow appears without an app release. API order is kept
// (newest first); [1m] variants aren't API ids, so they're gone.
async function fetchModels() {
  const fail = (error) => send({ type: 'models', models: [], error });
  const headers = anthropicAuthHeaders();
  if (!headers) return fail('Not logged in — run /login in any agent, then restart the app.');
  try {
    const resp = await fetch('https://api.anthropic.com/v1/models?limit=100', { headers });
    if (!resp.ok) return fail(`Model list failed: HTTP ${resp.status}`);
    const j = await resp.json();
    const models = (j.data || [])
      .filter(m => m.id && m.id.startsWith('claude-'))
      .map(m => ({ id: m.id, label: m.display_name || m.id, family: modelFamily(m.id) }));
    if (!models.length) return fail('API returned no models.');
    send({ type: 'models', models });
  } catch (e) {
    fail('Model list failed: ' + (e.message || 'network error').slice(0, 120));
  }
}

// User's default model for new sessions (set via /model in Claude Code)
function defaultModel() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf-8'));
    if (s.model) return s.model;
  } catch {}
  return null;
}

// OVERLORD_STATE_DIR sandboxes a test instance: own state/accounts, so it never
// restores (and never kills) the sessions of a concurrently running install.
const STATE_DIR = process.env.OVERLORD_STATE_DIR || path.join(os.homedir(), '.pixel-agents');
const STATE_FILE = path.join(STATE_DIR, 'overlord-state.json');
const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');

function protectClaudeConfig() {
  try {
    const data = JSON.parse(fs.readFileSync(CLAUDE_JSON, 'utf-8'));
    if (!data.hasCompletedOnboarding) {
      data.hasCompletedOnboarding = true;
      fs.writeFileSync(CLAUDE_JSON, JSON.stringify(data, null, 2));
      console.log('[Overlord] Restored hasCompletedOnboarding in ~/.claude.json');
    }
  } catch {}
}
const ACCOUNTS_PATH = path.join(STATE_DIR, 'accounts.json');
const LOG_FILE = path.join(STATE_DIR, 'overlord.log');

// Append-only diagnostic log so failures (worktree setup, git, PR, crashes) leave a
// readable trail on disk instead of vanishing into a truncated toast. Path is printed
// on startup; open it from any worktree's "Setup failed" menu too.
function flog(...args) {
  const msg = args.map(a => (typeof a === 'string' ? a : (a && a.stack) || JSON.stringify(a))).join(' ');
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.appendFileSync(LOG_FILE, line); } catch {}
  try { process.stdout.write(line); } catch {}
}
process.on('uncaughtException', (e) => flog('uncaughtException:', e));
process.on('unhandledRejection', (e) => flog('unhandledRejection:', e));

let mainWindow = null;
const agents = new Map();
const terminals = new Map();
const watchers = new Map();
const polls = new Map();
const permTimers = new Map();
const serverPorts = new Map(); // agentId -> Map(port -> url)
const teams = new Map(); // teamName -> { name, leadAgentId, leadSessionId, members[], tasks[] }
const agentTeamMap = new Map(); // agentId -> teamName
const knownJsonlFiles = new Map(); // projectDir -> Set<filePath>
const pendingClearAgents = new Set(); // agentIds that recently ran /clear — used to correctly assign new JSONL files
const termBuffers = new Map(); // agentId -> string (last TERM_BUFFER_MAX chars of terminal output)
const devServers = new Map(); // worktree path -> { proc, port, url, repo } (per-worktree dev server pty)

// /clear submitted: zero the context bar now. The new JSONL only appears on the next
// prompt, and reassignAgentToFile() (which resets the rest of stats) runs then.
function markClear(id) {
  pendingClearAgents.add(id);
  const a = agents.get(id);
  if (a) { a.stats.ctxTok = 0; send({ type: 'stats', id, stats: a.stats }); }
}
// /resume submitted: unlike /clear it usually lands in an existing JSONL (the picked
// chat's own), so reconcileResumedAgents() has to go find it. Rewinding to an older
// message forks a new file instead — markClear() covers that half.
const pendingResumeAgents = new Map(); // agentId -> ms epoch of the /resume
const RESUME_WINDOW_MS = 3 * 60 * 1000; // picker is interactive; give it time, then give up
function markResume(id) { pendingResumeAgents.set(id, Date.now()); }
// A submitted line that moves the agent to a different session file.
const SESSION_SWITCH_RE = /^\s*\/(clear|resume)(\s+\S+)?\s*$/;
function markSessionSwitch(id, line) {
  const m = SESSION_SWITCH_RE.exec(line);
  if (!m) return;
  markClear(id);
  if (m[1] === 'resume') markResume(id);
}
const TERM_BUFFER_MAX = 1_000_000; // ~10k lines — matches xterm scrollback so a reload can restore the whole visible history
let remoteWs = null; // current WebSocket connection (only one at a time)
let remoteViewingAgent = null; // which agent the mobile client is viewing
const REMOTE_PORT = 7778;
let nextId = 1;

function send(data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('msg', data);
  // Forward to mobile WebSocket client (skip termData unless viewing that agent)
  if (remoteWs && !remoteWs.destroyed) {
    if (data.type === 'termData') {
      if (data.id === remoteViewingAgent) wsSend(remoteWs, data);
    } else {
      wsSend(remoteWs, data);
    }
  }
}
function logToRenderer(...args) {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  console.log(msg);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('main-log', msg);
}

function sendFullState() {
  send({ type: 'settings', settings });
  for (const [id, a] of agents) {
    send({ type: 'agentCreated', id, cwd: a.cwd, sessionId: a.sessionId, title: a.title, customName: a.customName || false, createdAt: a.createdAt, agentName: a.agentName, archived: a.archived || false });
    if (a.lastPrompt) send({ type: 'prompt', id, text: a.lastPrompt });
    if (a.promptHistory.length) send({ type: 'promptHistory', id, prompts: [...a.promptHistory] });
    if (a.lastText) send({ type: 'preview', id, text: a.lastText });
    if (a.title) send({ type: 'title', id, text: a.title, customName: a.customName || false });
    if (a.isWaiting) send({ type: 'status', id, status: 'waiting' });
    else send({ type: 'status', id, status: 'active' });
    for (const [tid, st] of a.toolStatuses) {
      send({ type: 'toolStart', id, toolId: tid, status: st, name: a.toolNames.get(tid) });
      const subs = a.subToolIds.get(tid);
      const names = a.subToolNames.get(tid);
      if (subs && names) { for (const stid of subs) { const sn = names.get(stid) || ''; send({ type: 'subToolStart', id, parentToolId: tid, toolId: stid, status: fmtTool(sn, {}), name: sn }); } }
    }
    send({ type: 'stats', id, stats: a.stats });
    // Replay buffered terminal output so a renderer reload (Ctrl+Shift+R) restores scrollback
    // instead of showing a blank terminal. Renderer's termData handler lazily builds the xterm.
    const tbuf = termBuffers.get(id);
    if (tbuf) send({ type: 'termData', id, data: tbuf });
    const ports = serverPorts.get(id);
    if (ports) { for (const [port, url] of ports) send({ type: 'serverDetected', id, port, url }); }
    if (a.cronCount > 0) send({ type: 'looping', id, active: true, count: a.cronCount });
    if (a.compacting) send({ type: 'compacting', id, active: true });
  }
  for (const [, teamData] of teams) {
    send({ type: 'teamDetected', team: { name: teamData.name, leadAgentId: teamData.leadAgentId, members: teamData.members, tasks: teamData.tasks } });
  }
  if (lastUsage) send({ type: 'usage', usage: lastUsage });
  send({ type: 'accountInfo', ...getCurrentAccountInfo() });
  if (remoteServer) sendPeersState(); // only meaningful once the server picked its port
  fetchUsage();
}

function claudeDir(projectPath) {
  return path.join(os.homedir(), '.claude', 'projects', projectPath.replace(/[^a-zA-Z0-9]/g, '-'));
}

function deriveTitle(text) {
  const clean = text.replace(/[\n\r]+/g, ' ').trim();
  const words = clean.split(/\s+/).slice(0, 5).join(' ');
  return words.length > 40 ? words.slice(0, 40) + '\u2026' : words;
}

// All process cleanup is async — sync wmic/taskkill calls used to block the main
// process (and the whole UI) for seconds per call. wmic is also removed on newer
// Windows 11 builds, so process lookup goes through PowerShell CIM instead.
function killProcessTreeAsync(pid) {
  if (!pid) return Promise.resolve();
  return new Promise(resolve => {
    if (process.platform === 'win32') {
      exec(`taskkill /PID ${pid} /T /F`, { windowsHide: true }, () => resolve());
    } else {
      try { process.kill(pid, 'SIGTERM'); } catch {}
      resolve();
    }
  });
}

// One process-table scan, then kill every PID whose command line contains any of
// the given substrings. Batching N session ids into one scan matters on restore:
// one PowerShell spawn instead of N wmic spawns.
function killProcessesByCmdline(substrings) {
  const subs = (substrings || []).filter(Boolean);
  if (!subs.length) return Promise.resolve();
  return new Promise(resolve => {
    if (process.platform === 'win32') {
      const ps = "Get-CimInstance Win32_Process | ForEach-Object { $_.ProcessId.ToString() + '|' + $_.CommandLine }";
      execFile('powershell', ['-NoProfile', '-Command', ps], { timeout: 20000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, out) => {
        if (err || !out) return resolve();
        const kills = [];
        for (const line of out.split(/[\r\n]+/)) {
          const sep = line.indexOf('|');
          if (sep < 1) continue;
          const pid = parseInt(line.slice(0, sep), 10);
          const cmdline = line.slice(sep + 1);
          if (!pid || pid === process.pid) continue;
          if (subs.some(s => cmdline.includes(s))) {
            kills.push(new Promise(r => exec(`taskkill /PID ${pid} /F`, { windowsHide: true }, () => r())));
          }
        }
        Promise.all(kills).then(() => resolve());
      });
    } else {
      Promise.all(subs.map(s => new Promise(r => exec(`pkill -f "${s}"`, () => r())))).then(() => resolve());
    }
  });
}

function killSessionProcessesAsync(sessionId) {
  if (!sessionId) return Promise.resolve();
  return killProcessesByCmdline([sessionId]);
}

// ── Server URL detection ──────────────────────────────
// Scans tool output (JSONL) and raw terminal stream for localhost URLs.
function scanForServers(id, text) {
  if (!text || typeof text !== 'string') return;
  let match;
  SERVER_URL_RE.lastIndex = 0;
  while ((match = SERVER_URL_RE.exec(text)) !== null) {
    const url = match[0];
    const port = parseInt(match[1], 10);
    if (port < 1024 || port > 65535) continue;
    let ports = serverPorts.get(id);
    if (!ports) { ports = new Map(); serverPorts.set(id, ports); }
    if (!ports.has(port)) {
      const normalUrl = `http://localhost:${port}`;
      ports.set(port, normalUrl);
      console.log(`[Overlord] Server detected for agent ${id}: ${normalUrl}`);
      send({ type: 'serverDetected', id, port, url: normalUrl });
    }
  }
}

function killPortProcess(port) {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr LISTENING | findstr :${port}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
      const pids = new Set();
      for (const line of out.split('\n')) {
        const m = line.trim().match(/:(\d+)\s.*LISTENING\s+(\d+)/);
        if (m && parseInt(m[1]) === port) pids.add(parseInt(m[2]));
      }
      for (const pid of pids) { try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch {} }
    } else {
      execSync(`lsof -ti tcp:${port} | xargs kill -9`, { stdio: 'ignore' });
    }
  } catch {}
}

function clearServers(id) {
  const ports = serverPorts.get(id);
  if (ports && ports.size > 0) {
    serverPorts.delete(id);
    send({ type: 'serversClear', id });
  }
}


async function generateSummaryTitle(id) {
  const a = agents.get(id);
  if (!a || a.customName || !a.promptHistory || a.promptHistory.length === 0 || a.titlePending) return;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return;
  a.titlePending = true;
  const context = a.promptHistory.map((p, i) => `Prompt ${i + 1}: ${p}`).join('\n');
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: TITLE_MODEL, max_tokens: 30,
        messages: [{ role: 'user', content: `Summarize this coding session in exactly 5 words. Be specific about what's being worked on. No punctuation, no quotes. Just 5 lowercase words.\n\n${context}` }],
      }),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    if (!agents.has(id)) return;
    const text = data.content?.[0]?.text?.trim();
    if (!text) return;
    a.title = text.split(/\s+/).slice(0, 5).join(' ');
    send({ type: 'title', id, text: a.title });
    saveState();
  } catch (e) { console.log('[Overlord] Title generation failed:', e.message); }
  finally { if (a) a.titlePending = false; }
}

// Inline ghost-text autocomplete: complete the partial prompt the user is
// typing into a live agent's terminal. Replies with a `ghost` message the
// renderer overlays. Silent (empty suggestion) on no key / error / timeout.
async function ghostComplete(id, reqId, prefix, context) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const reply = (suggestion) => send({ type: 'ghost', id, reqId, suggestion });
  if (!apiKey || !prefix) return reply('');
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 2500);
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: TITLE_MODEL, max_tokens: 48,
        system: 'You are an inline autocomplete for prompts a developer types to a coding agent (Claude Code). Given the recent terminal output and the current partial line, output ONLY the text that should continue the current line after the cursor. No quotes, no explanation, one line, at most ~12 words. If you cannot confidently continue, output nothing.',
        messages: [{ role: 'user', content: `Recent terminal output:\n${context || '(none)'}\n\nCurrent line so far:\n${prefix}\n\nContinuation:` }],
      }),
    });
    clearTimeout(to);
    if (!resp.ok) return reply('');
    const data = await resp.json();
    reply(data.content?.[0]?.text || '');
  } catch { reply(''); }
}

// Check if text is a system/internal message rather than a real user prompt
const SYSTEM_MSG_RE = /^<(?:command-name|local-command|system-reminder|task-notification|user-prompt-submit-hook|antml:)/;
function isSystemMessage(text) { return SYSTEM_MSG_RE.test(text.trim()); }

function getLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

// ── WebSocket protocol (minimal, text frames only) ──
function wsHandshake(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return null; }
  // RFC 6455 magic GUID — clients validate Sec-WebSocket-Accept against this
  // exact constant; anything else fails the browser handshake.
  const accept = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  return socket;
}

function wsEncodeFrame(text) {
  const data = Buffer.from(text, 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  return Buffer.concat([header, data]);
}

function wsDecodeFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let payloadLen = buffer[1] & 0x7f;
  let offset = 2;
  if (payloadLen === 126) {
    if (buffer.length < 4) return null;
    payloadLen = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buffer.length < 10) return null;
    payloadLen = Number(buffer.readUInt32BE(6));
    offset = 10;
  }
  const maskLen = masked ? 4 : 0;
  const totalLen = offset + maskLen + payloadLen;
  if (buffer.length < totalLen) return null;
  let payload;
  if (masked) {
    const mask = buffer.slice(offset, offset + 4);
    payload = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i++) {
      payload[i] = buffer[offset + 4 + i] ^ mask[i % 4];
    }
  } else {
    payload = buffer.slice(offset, offset + payloadLen);
  }
  return { opcode, data: payload.toString('utf8'), totalLen };
}

function wsSend(socket, data) {
  if (!socket || socket.destroyed) return;
  try { socket.write(wsEncodeFrame(typeof data === 'string' ? data : JSON.stringify(data))); } catch {}
}

function setPrompt(id, a, text) {
  // Skip system/internal messages — they're not real user prompts
  if (isSystemMessage(text)) return;
  a.lastPrompt = text.length > PREVIEW_MAX ? text.slice(0, PREVIEW_MAX) + '\u2026' : text;
  const brief = text.length > PROMPT_BRIEF_MAX ? text.slice(0, PROMPT_BRIEF_MAX) : text;
  a.promptHistory.push(brief);
  if (a.promptHistory.length > PROMPT_HISTORY_MAX) a.promptHistory.shift();
  if (!a.customName) {
    a.title = deriveTitle(text);
    send({ type: 'title', id, text: a.title });
    saveState();
  }
  send({ type: 'prompt', id, text: a.lastPrompt });
  send({ type: 'promptHistory', id, prompts: [...a.promptHistory] });
}

// ── Spinner text extraction from raw PTY data ──────────
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\x1b[78]|\x1b\[\?[0-9;]*[hl]/g;
const spinnerDebounce = new Map();
function extractSpinnerText(id, data) {
  const stripped = data.replace(ANSI_RE, '');
  const parts = stripped.split(/[\r\n]/);
  for (let i = parts.length - 1; i >= 0; i--) {
    const t = parts[i].trim();
    if (!t || t.length < 3 || t.length > 120) continue;
    const cp = t.codePointAt(0);
    // Braille spinner chars (U+2800-U+28FF), * prefix, or ✻ (U+273B) / ❯ (U+276F)
    if ((cp >= 0x2800 && cp <= 0x28FF) || t[0] === '*' || cp === 0x273B || cp === 0x276F) {
      const text = t.replace(/^.\s*/, '').trim();
      if (text && text.length > 1) {
        // Completion messages like "Sautéed for 36s" or "Cooked for 2m 44s" mean the turn is done — clear spinner
        if (/\bfor\s+\d+[smh]/i.test(text)) {
          const a = agents.get(id);
          if (a) {
            if (a.spinnerText) { a.spinnerText = ''; send({ type: 'spinnerText', id, text: '' }); }
            // ponytail: pty completion line = ground-truth turn-done; backstop when turn_duration is missing (else stuck 'active' forever)
            if (!a.isWaiting) { a.isWaiting = true; a.permSent = false; clrTimer(id, permTimers); send({ type: 'status', id, status: 'waiting' }); flushPeerMsgs(id); }
          }
          return;
        }
        const a = agents.get(id);
        if (a && a.spinnerText !== text) {
          a.spinnerText = text;
          // Don't flip waiting→active from spinner text alone — JSONL tool_use events are authoritative
          clearTimeout(spinnerDebounce.get(id));
          spinnerDebounce.set(id, setTimeout(() => {
            spinnerDebounce.delete(id);
            send({ type: 'spinnerText', id, text });
          }, SPINNER_DEBOUNCE_MS));
        }
        return;
      }
    }
  }
}

function fmtTool(name, input) {
  const b = (p) => typeof p === 'string' ? path.basename(p) : '';
  switch (name) {
    case 'Read': return `Reading ${b(input.file_path)}`;
    case 'Edit': return `Editing ${b(input.file_path)}`;
    case 'Write': return `Writing ${b(input.file_path)}`;
    case 'Bash': { const c = input.command || ''; return `Running: ${c.length > 30 ? c.slice(0, 30) + '\u2026' : c}`; }
    case 'Glob': return 'Searching files';
    case 'Grep': return 'Searching code';
    case 'WebFetch': return 'Fetching web content';
    case 'WebSearch': return 'Searching the web';
    case 'Task': case 'Agent': { const d = typeof input.description === 'string' ? input.description : ''; return d ? `Subtask: ${d.length > 40 ? d.slice(0, 40) + '\u2026' : d}` : 'Running subtask'; }
    case 'AskUserQuestion': return 'Waiting for your answer';
    case 'CronCreate': { const p = typeof input.prompt === 'string' ? input.prompt : ''; return p ? `Scheduling: ${p.length > 40 ? p.slice(0, 40) + '\u2026' : p}` : 'Scheduling loop'; }
    case 'CronDelete': return 'Stopping loop';
    case 'CronList': return 'Listing loops';
    default: return `Using ${name}`;
  }
}

// ── Timeline parsing ──────────────────────────────────
let timelineAgentId = null;
const TIMELINE_MAX_EVENTS = 1000;

function parseLineForTimeline(line) {
  try {
    const r = JSON.parse(line);
    const ts = r.timestamp || null;
    if (r.type === 'assistant' && Array.isArray(r.message?.content)) {
      const events = [];
      for (const b of r.message.content) {
        if (b.type === 'text' && b.text) {
          events.push({ type: 'text', ts, text: b.text.length > 200 ? b.text.slice(0, 200) + '\u2026' : b.text });
        }
        if (b.type === 'tool_use' && b.id) {
          events.push({ type: 'tool', ts, name: b.name || 'unknown', text: fmtTool(b.name || '', b.input || {}), toolId: b.id });
        }
      }
      return events.length ? events : null;
    }
    if (r.type === 'user') {
      const c = r.message?.content;
      if (Array.isArray(c)) {
        if (c.some(b => b.type === 'tool_result')) {
          const events = [];
          for (const b of c) {
            if (b.type === 'tool_result' && b.tool_use_id) {
              const out = typeof b.content === 'string' ? b.content : '';
              events.push({ type: 'tool_done', ts, toolId: b.tool_use_id, text: out.length > 150 ? out.slice(0, 150) + '\u2026' : out });
            }
          }
          return events.length ? events : null;
        }
        const txt = c.filter(b => b.type === 'text').map(b => b.text || '').join('').trim();
        if (txt && !isSystemMessage(txt)) return [{ type: 'prompt', ts, text: txt.length > 200 ? txt.slice(0, 200) + '\u2026' : txt }];
      } else if (typeof c === 'string' && c.trim()) {
        const txt = c.trim();
        if (!isSystemMessage(txt)) return [{ type: 'prompt', ts, text: txt.length > 200 ? txt.slice(0, 200) + '\u2026' : txt }];
      }
    }
    if (r.type === 'system' && r.subtype === 'turn_duration') {
      return [{ type: 'turn', ts, text: `Turn completed (${Math.round((r.durationMs || 0) / 1000)}s)` }];
    }
    if (r.type === 'progress' && r.data?.type === 'agent_progress') {
      const msg = r.data.message;
      if (msg?.type === 'assistant' && Array.isArray(msg.message?.content)) {
        for (const b of msg.message.content) {
          if (b.type === 'tool_use') {
            return [{ type: 'subtask', ts, name: b.name, text: fmtTool(b.name || '', b.input || {}) }];
          }
        }
      }
    }
  } catch {}
  return null;
}

function getFullTimeline(id) {
  const a = agents.get(id);
  if (!a || !fs.existsSync(a.jsonlFile)) return [];
  try {
    const content = fs.readFileSync(a.jsonlFile, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    const events = [];
    for (const line of lines) {
      const parsed = parseLineForTimeline(line);
      if (parsed) events.push(...parsed);
    }
    // Return last N events if too many
    return events.length > TIMELINE_MAX_EVENTS ? events.slice(-TIMELINE_MAX_EVENTS) : events;
  } catch { return []; }
}

function globalSearch(query) {
  if (!query || query.length < 2) return [];
  const q = query.toLowerCase();
  const results = [];
  const MAX_RESULTS = 100;
  const CONTEXT_CHARS = 120;
  for (const [id, a] of agents) {
    if (results.length >= MAX_RESULTS) break;
    if (!a.jsonlFile || !fs.existsSync(a.jsonlFile)) continue;
    try {
      const content = fs.readFileSync(a.jsonlFile, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        if (results.length >= MAX_RESULTS) break;
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line);
          let texts = [];
          let role = '';
          if (r.type === 'assistant' && Array.isArray(r.message?.content)) {
            role = 'assistant';
            for (const b of r.message.content) {
              if (b.type === 'text' && b.text) texts.push(b.text);
            }
          } else if (r.type === 'user') {
            role = 'user';
            const c = r.message?.content;
            if (Array.isArray(c)) {
              for (const b of c) {
                if (b.type === 'text' && b.text) texts.push(b.text);
              }
            } else if (typeof c === 'string') texts.push(c);
          }
          for (const txt of texts) {
            const idx = txt.toLowerCase().indexOf(q);
            if (idx === -1) continue;
            const start = Math.max(0, idx - 40);
            const end = Math.min(txt.length, idx + q.length + CONTEXT_CHARS - 40);
            let snippet = txt.slice(start, end).replace(/[\n\r]+/g, ' ');
            if (start > 0) snippet = '\u2026' + snippet;
            if (end < txt.length) snippet += '\u2026';
            results.push({
              agentId: id,
              agentName: a.agentName || '',
              title: a.title || '',
              cwd: a.cwd || '',
              role,
              snippet,
              matchIdx: idx,
              ts: r.timestamp || null,
            });
            break; // one match per message block
          }
        } catch {}
      }
    } catch {}
  }
  return results;
}

// ── State persistence ─────────────────────────────────
let settings = { zoom: 100, bypassPermissions: true, notifications: true, notificationSound: true, planBudget: 100, peersEnabled: false, peerName: null, peerCode: null, peers: [] };

function saveState() {
  const agentEntries = [];
  for (const [id, a] of agents) {
    const wasActive = !a.isWaiting;
    let jsonlSize = 0;
    try { jsonlSize = fs.statSync(a.jsonlFile).size; } catch {}
    const termProc = terminals.get(id);
    agentEntries.push({ cwd: a.cwd, sessionId: a.sessionId, lastPrompt: a.lastPrompt, lastText: a.lastText, title: a.title, customName: a.customName || false, createdAt: a.createdAt, wasActive, jsonlSize, pid: termProc?.pid || null, agentName: a.agentName, stats: a.stats, promptHistory: a.promptHistory, cronCount: a.cronCount, archived: a.archived || false });
  }
  const state = { agents: agentEntries, settings };
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state, null, 2));
    fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
  } catch (e) { console.log('[Overlord] Failed to save state:', e.message); }
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return { agents: [], settings: {} };
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    // Handle old format (plain array)
    if (Array.isArray(data)) return { agents: data, settings: {} };
    return { agents: data.agents || [], settings: data.settings || {} };
  } catch { return { agents: [], settings: {} }; }
}

function restoreAgents(state) {
  if (!state) state = loadState();
  if (!settings._merged) { settings = { ...settings, ...state.settings }; settings._merged = true; }
  const saved = state.agents;
  if (saved.length === 0) return;

  // ── Phase 1: Instant — create agent entries from saved metadata (no I/O) ──
  // Restore all agents regardless of whether they were active or idle when the app closed.
  // Active agents' orphan processes will be cleaned up in Phase 2.
  const restoredNames = new Set();
  const agentEntries = []; // { id, entry } pairs for phase 2
  for (const entry of saved) {
    const { cwd, sessionId, lastPrompt, lastText, title, customName, createdAt } = entry;
    if (!cwd || !sessionId) continue; // skip corrupted entries
    const jsonlFile = path.join(claudeDir(cwd), `${sessionId}.jsonl`);
    const id = nextId++;

    let agentName = entry.agentName || null;
    if (!agentName || restoredNames.has(agentName)) agentName = null;

    // Restore stats from saved state if available (avoids JSONL re-parse)
    const savedStats = entry.stats || { inTok: 0, outTok: 0, cacheTok: 0, cacheRead: 0, ctxTok: 0, turns: 0, durMs: 0, tools: {}, files: 0, modelFamily: 'sonnet' };
    const agent = {
      id, sessionId, cwd, jsonlFile,
      fileOffset: 0, lineBuffer: '',
      toolIds: new Set(), toolStatuses: new Map(), toolNames: new Map(),
      subToolIds: new Map(), subToolNames: new Map(),
      isWaiting: true, permSent: false, hadTools: false, turnTools: 0,
      lastText: lastText || '', lastPrompt: lastPrompt || '', title: title || '', customName: customName || false,
      promptHistory: entry.promptHistory || [], titlePending: false, createdAt: createdAt || Date.now(),
      crashCount: 0, cronCount: entry.cronCount || 0, compacting: false, orphanAlive: false, agentName: agentName, spinnerText: '',
      archived: entry.archived || false,
      stats: savedStats,
    };
    agents.set(id, agent);
    if (!agent.agentName) agent.agentName = pickAgentName();
    restoredNames.add(agent.agentName);
    agentEntries.push({ id, entry });
    // Register JSONL immediately (Phase 1) to prevent scanForNewJsonlFiles from reassigning stale files
    registerKnownJsonl(claudeDir(cwd), jsonlFile);
    console.log(`[Overlord] Restored agent ${id}: session=${sessionId} cwd=${cwd}`);
  }

  // Pre-register ALL existing JSONL files in each project dir to prevent stale files
  // from being mistakenly treated as "new" by scanForNewJsonlFiles after restart
  const seenDirs = new Set();
  for (const { entry } of agentEntries) {
    const dir = claudeDir(entry.cwd);
    if (seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f));
      for (const file of files) registerKnownJsonl(dir, file);
    } catch {}
  }

  // ── Phase 2: Async — kill orphans in one sweep, parse JSONL, pre-warm terminals ──
  protectClaudeConfig();
  (async () => {
    // Kill saved orphan PIDs + anything still holding a session lock — one process
    // scan for all agents instead of one wmic call per agent. All terminal spawns
    // wait on _restoreSweep so the sweep can never kill a freshly spawned claude.
    const sweep = (async () => {
      await Promise.all(agentEntries.map(({ entry }) => killProcessTreeAsync(entry.pid)));
      await killProcessesByCmdline(agentEntries.map(({ entry }) => entry.sessionId));
      // Sessions swept — spawnTerminal can skip its own kill pass for these agents.
      for (const { id } of agentEntries) { const ag = agents.get(id); if (ag) ag._sessionCleaned = true; }
    })();
    _restoreSweep = sweep;
    await sweep;
    for (const { id, entry } of agentEntries) {
      const agent = agents.get(id);
      if (!agent) continue; // closed while we were killing

      // If no saved stats, rebuild from JSONL (legacy state files)
      if (!entry.stats && fs.existsSync(agent.jsonlFile)) {
        try {
          const content = fs.readFileSync(agent.jsonlFile, 'utf-8');
          const lines = content.split('\n').filter(l => l.trim());
          for (const line of lines) {
            try {
              const r = JSON.parse(line);
              if (r.type === 'assistant' && r.message?.usage) {
                if (r.message.model) { agent.stats.modelFamily = modelFamily(r.message.model); agent.stats.model = r.message.model; }
                const u = r.message.usage;
                agent.stats.inTok += u.input_tokens || 0;
                agent.stats.outTok += u.output_tokens || 0;
                agent.stats.ctxTok = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
                agent.stats.cacheTok += u.cache_creation_input_tokens || 0;
                agent.stats.cacheRead += u.cache_read_input_tokens || 0;
              }
              if (r.type === 'assistant' && Array.isArray(r.message?.content)) {
                for (const b of r.message.content) {
                  if (b.type === 'text' && b.text) {
                    agent.lastText = b.text.length > PREVIEW_MAX ? b.text.slice(0, PREVIEW_MAX) + '\u2026' : b.text;
                  }
                  if (b.type === 'tool_use' && b.name) {
                    agent.stats.tools[b.name] = (agent.stats.tools[b.name] || 0) + 1;
                    if (b.input?.file_path && ['Read', 'Write', 'Edit'].includes(b.name)) agent.stats.files++;
                    if (b.name === 'CronCreate') agent.cronCount++;
                    if (b.name === 'CronDelete') agent.cronCount = Math.max(0, agent.cronCount - 1);
                  }
                }
              }
              if (r.type === 'user') {
                const c = r.message?.content;
                let pTxt = '';
                if (typeof c === 'string' && c.trim()) pTxt = c;
                else if (Array.isArray(c)) pTxt = c.filter(b => b.type === 'text').map(b => b.text || '').join('').trim();
                if (pTxt && !isSystemMessage(pTxt)) {
                  agent.lastPrompt = pTxt.length > PREVIEW_MAX ? pTxt.slice(0, PREVIEW_MAX) + '\u2026' : pTxt;
                  if (!agent.title && !agent.customName) agent.title = deriveTitle(pTxt);
                  const brief = pTxt.length > PROMPT_BRIEF_MAX ? pTxt.slice(0, PROMPT_BRIEF_MAX) : pTxt;
                  agent.promptHistory.push(brief);
                  if (agent.promptHistory.length > PROMPT_HISTORY_MAX) agent.promptHistory.shift();
                }
              }
              if (r.type === 'system' && r.subtype === 'compact_boundary') {
                agent.stats.ctxTok = 0;
              }
              if (r.type === 'system' && r.subtype === 'turn_duration') {
                agent.stats.turns++;
                agent.stats.durMs += r.durationMs || 0;
              }
            } catch {}
          }
          send({ type: 'stats', id, stats: agent.stats });
          send({ type: 'preview', id, text: agent.lastText });
        } catch {}
      }

      // Set fileOffset from actual file size for live watching
      try { agent.fileOffset = fs.statSync(agent.jsonlFile).size; } catch {}

      registerKnownJsonl(claudeDir(agent.cwd), agent.jsonlFile);
      if (fs.existsSync(agent.jsonlFile) && !watchers.has(id) && !polls.has(id)) startWatch(id);

      // Pre-warm terminals in the background (staggered — concurrent `claude`
      // startups race-write ~/.claude.json) so clicking an agent connects instantly
      // instead of paying `claude --resume` cold-start on click. The old freeze that
      // killed pre-warming came from sync wmic kills, not from spawning itself.
      if (!agent.archived) queuePrewarm(id);
    }
  })();
}

// ── Terminal pre-warm queue ────────────────────────────
let _restoreSweep = Promise.resolve(); // resolves once startup orphan cleanup finished
const PREWARM_STAGGER_MS = 1500;
let _prewarmChain = Promise.resolve();
function queuePrewarm(id) {
  _prewarmChain = _prewarmChain.then(() => new Promise(res => {
    const a = agents.get(id);
    if (!a || a.archived || terminals.has(id) || spawningTerms.has(id)) return res();
    spawnTerminal(id);
    setTimeout(res, PREWARM_STAGGER_MS);
  }));
}

function handleTermExit(id, exitCode) {
  const a = agents.get(id);
  if (!a) return;
  terminals.delete(id);
  // If we're retrying due to --resume failure, don't treat as crash or send termExit
  if (a._resumeFailed && a._resumeRetrying) { a._resumeRetrying = false; return; }
  // Archiving kills the pty on purpose. Without this, the non-zero exit reads as a crash
  // and auto-resume would respawn the terminal for the agent that was just archived.
  if (a.archived) return;
  // Crash = any non-zero exit. Claude dying at the prompt (not mid-tool) is still a crash;
  // the old `wasActive` gate silently let those through as a normal "[Session ended]".
  // A clean exit (user typed /exit, code 0) is still not a crash.
  const crashed = exitCode !== 0 && exitCode !== undefined;
  if (crashed) a.crashed = true; // watchdog must not flip a crashed card to 'waiting'
  if (crashed && a.crashCount < MAX_CRASH_RETRIES) {
    a.crashCount++;
    console.log(`[Overlord] Agent ${id} crashed (exit ${exitCode}), auto-resuming (${a.crashCount}/${MAX_CRASH_RETRIES})`);
    send({ type: 'termData', id, data: `\r\n\x1b[33m[Crashed — auto-resuming ${a.crashCount}/${MAX_CRASH_RETRIES}...]\x1b[0m\r\n` });
    send({ type: 'crashed', id, crashCount: a.crashCount, maxRetries: MAX_CRASH_RETRIES });
    setTimeout(() => {
      if (!agents.has(id)) return;
      spawnTerminal(id);
    }, CRASH_RESUME_DELAY_MS);
  } else if (crashed) {
    console.log(`[Overlord] Agent ${id} crashed (exit ${exitCode}), max retries reached`);
    send({ type: 'termData', id, data: `\r\n\x1b[31m[Crashed — max retries (${MAX_CRASH_RETRIES}) reached. Use restart button to try again.]\x1b[0m\r\n` });
    send({ type: 'crashed', id, crashCount: a.crashCount, maxRetries: MAX_CRASH_RETRIES, fatal: true });
  } else {
    send({ type: 'termExit', id, code: exitCode });
  }
}


function safeCwd(cwd) {
  return (cwd && fs.existsSync(cwd)) ? cwd : os.homedir();
}

const spawningTerms = new Set(); // ids with an async pre-spawn kill in flight

function spawnTerminal(id) {
  if (terminals.has(id) || spawningTerms.has(id)) return; // already running/starting
  const a = agents.get(id);
  if (!a) return;
  protectClaudeConfig(); // keep hasCompletedOnboarding set before each `claude` launch

  // If an orphaned Claude process is still writing, don't spawn a conflicting --resume.
  // Show a message and wait for it to finish (detected via turn_duration in JSONL watcher).
  if (a.orphanAlive) {
    send({ type: 'termData', id, data: '\x1b[33m[Agent is still running from previous session \u2014 waiting for current turn to finish...]\x1b[0m\r\n' });
    return;
  }

  // Kill any lingering session-lock holder without blocking the UI. Restore's bulk
  // sweep already covered this session once \u2014 skip the redundant pass then.
  if (a._sessionCleaned) {
    a._sessionCleaned = false;
    doSpawnTerminal(id);
    return;
  }
  spawningTerms.add(id);
  send({ type: 'termData', id, data: '\x1b[90m[Connecting\u2026]\x1b[0m\r\n' });
  (async () => {
    await _restoreSweep; // never race the startup sweep \u2014 it could kill our fresh claude
    if (a._sessionCleaned) a._sessionCleaned = false; // sweep covered us while waiting
    else await killSessionProcessesAsync(a.sessionId);
    spawningTerms.delete(id);
    if (agents.has(id) && !terminals.has(id)) doSpawnTerminal(id);
  })();
}

function doSpawnTerminal(id) {
  const a = agents.get(id);
  if (!a) return;
  const hasJsonl = fs.existsSync(a.jsonlFile);
  const skip = settings.bypassPermissions ? ' --dangerously-skip-permissions' : '';
  const useResume = hasJsonl && !a._resumeFailed;
  const feat = featureAgentArgs(a.cwd);
  const claudeCmd = (useResume ? `claude --resume ${a.sessionId}${skip}` : `claude --session-id ${a.sessionId}${skip}`) + feat.flags;
  const sh = process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL || 'bash');
  const args = process.platform === 'win32' ? `/k ${claudeCmd}` : ['-c', claudeCmd];
  try {
    const proc = pty.spawn(sh, args, { name: 'xterm-256color', cols: 120, rows: 30, cwd: safeCwd(a.cwd), env: { ...process.env, ...feat.env } });
    terminals.set(id, proc);
    // Flush any input that arrived before PTY was ready
    const queued = pendingTermInput.get(id);
    if (queued && queued.length > 0) {
      pendingTermInput.delete(id);
      for (const d of queued) handleTermInput(id, d);
    }
    let resumeErrorBuf = '';
    proc.onData((d) => {
      try { send({ type: 'termData', id, data: d }); scanForServers(id, d); extractSpinnerText(id, d); } catch {}
      // Buffer terminal output for mobile remote
      let buf = termBuffers.get(id) || '';
      buf += d;
      if (buf.length > TERM_BUFFER_MAX) buf = buf.slice(-TERM_BUFFER_MAX);
      termBuffers.set(id, buf);
      // Detect resume errors and retry
      if (!a._resumeHandled) {
        resumeErrorBuf += d;
        if (resumeErrorBuf.length > 4096) resumeErrorBuf = resumeErrorBuf.slice(-2048);
        const clean = resumeErrorBuf.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
        if (!a._onboardingHandled && /Choose the text style|Let's get started/i.test(clean)) {
          a._onboardingHandled = true;
          console.log(`[Overlord] Onboarding screen detected for agent ${id} — auto-selecting theme and restarting`);
          protectClaudeConfig();
          try { proc.kill(); } catch {}
          setTimeout(() => { if (agents.has(id)) { terminals.delete(id); spawnTerminal(id); } }, 1000);
        } else if (useResume && !a._resumeFailed && /No conversation found with session ID/i.test(clean)) {
          a._resumeFailed = true;
          a._resumeRetrying = true;
          a._resumeHandled = true;
          resumeErrorBuf = '';
          console.log(`[Overlord] --resume failed for agent ${id} (session not found), retrying with --session-id`);
          send({ type: 'termData', id, data: '\r\n\x1b[33m[Session expired — starting fresh conversation...]\x1b[0m\r\n' });
          try { proc.kill(); } catch {}
          setTimeout(() => { if (agents.has(id)) { terminals.delete(id); spawnTerminal(id); } }, 500);
        } else if (/session.{0,5}id.{0,30}already in use/i.test(clean)) {
          const retries = a._lockRetries || 0;
          if (retries < 5) {
            a._lockRetries = retries + 1;
            a._resumeRetrying = true;
            resumeErrorBuf = '';
            const delay = 2000 * a._lockRetries;
            console.log(`[Overlord] Session lock busy for agent ${id}, retry ${a._lockRetries}/5 in ${delay}ms`);
            send({ type: 'termData', id, data: `\r\n\x1b[33m[Session locked — retrying in ${delay / 1000}s (${a._lockRetries}/5)...]\x1b[0m\r\n` });
            try { proc.kill(); } catch {}
            setTimeout(() => {
              if (!agents.has(id)) return;
              terminals.delete(id);
              killSessionProcessesAsync(a.sessionId).then(() => { if (agents.has(id)) spawnTerminal(id); });
            }, delay);
          } else {
            a._resumeHandled = true;
            console.log(`[Overlord] Session lock retries exhausted for agent ${id}`);
            send({ type: 'termData', id, data: '\r\n\x1b[31m[Session lock stuck — click to retry manually.]\x1b[0m\r\n' });
          }
        }
      }
    });
    proc.onExit((e) => { handleTermExit(id, e?.exitCode); try { proc.destroy(); } catch {} });
  } catch (e) {
    console.log(`[Overlord] Failed to spawn terminal for agent ${id}:`, e.message);
    send({ type: 'termData', id, data: `\r\n\x1b[31mFailed to start terminal: ${e.message}\x1b[0m\r\n` });
  }
  startWatch(id);
}

// ── Agent lifecycle ────────────────────────────────────
function createAgent(folderPath, initialPrompt) {
  const cwd = folderPath || os.homedir();
  const sessionId = crypto.randomUUID();
  const id = nextId++;
  const agent = {
    id, sessionId, cwd,
    jsonlFile: path.join(claudeDir(cwd), `${sessionId}.jsonl`),
    fileOffset: 0, lineBuffer: '',
    toolIds: new Set(), toolStatuses: new Map(), toolNames: new Map(),
    subToolIds: new Map(), subToolNames: new Map(),
    isWaiting: false, permSent: false, hadTools: false, turnTools: 0,
    lastText: '', lastPrompt: '', title: '', customName: false,
    promptHistory: [], titlePending: false, createdAt: Date.now(),
    crashCount: 0, cronCount: 0, compacting: false, agentName: pickAgentName(), spinnerText: '',
    archived: false,
    stats: { inTok: 0, outTok: 0, cacheTok: 0, cacheRead: 0, ctxTok: 0, turns: 0, durMs: 0, tools: {}, files: 0, modelFamily: modelFamily(defaultModel()), model: defaultModel() || undefined },
  };
  agents.set(id, agent);

  const skip = settings.bypassPermissions ? ' --dangerously-skip-permissions' : '';
  const feat = featureAgentArgs(cwd);
  const claudeCmd = `claude --session-id ${sessionId}${skip}${feat.flags}`;
  const shell = process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL || 'bash');
  const shellArgs = process.platform === 'win32' ? `/k ${claudeCmd}` : ['-c', claudeCmd];
  send({ type: 'agentCreated', id, cwd, sessionId, createdAt: agent.createdAt, agentName: agent.agentName });
  send({ type: 'stats', id, stats: agent.stats });
  send({ type: 'focused', id });

  const agentEnv = { ...process.env, CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1', ...feat.env };
  try {
    const proc = pty.spawn(shell, shellArgs, { name: 'xterm-256color', cols: 120, rows: 30, cwd: safeCwd(cwd), env: agentEnv });
    terminals.set(id, proc);
    let promptSent = !initialPrompt;
    proc.onData((d) => {
      try { send({ type: 'termData', id, data: d }); scanForServers(id, d); extractSpinnerText(id, d); } catch {}
      // Buffer terminal output for mobile remote
      let buf = termBuffers.get(id) || '';
      buf += d;
      if (buf.length > TERM_BUFFER_MAX) buf = buf.slice(-TERM_BUFFER_MAX);
      termBuffers.set(id, buf);
      // Detect Claude ready prompt and send the initial prompt
      if (!promptSent) {
        const clean = d.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
        if (/>\s*$/.test(clean)) {
          promptSent = true;
          setTimeout(() => { try { proc.write(initialPrompt + '\r'); } catch {} }, 100);
        }
      }
    });
    proc.onExit((e) => { handleTermExit(id, e?.exitCode); try { proc.destroy(); } catch {} });
    // Fallback: send prompt after timeout if ready-detection didn't fire
    if (initialPrompt) {
      setTimeout(() => { if (!promptSent) { promptSent = true; try { proc.write(initialPrompt + '\r'); } catch {} } }, 8000);
    }
  } catch (e) {
    console.log(`[Overlord] Failed to spawn agent ${id}:`, e.message);
    send({ type: 'termData', id, data: `\r\n\x1b[31mFailed to start: ${e.message}\x1b[0m\r\n` });
  }
  saveState();
  registerKnownJsonl(claudeDir(cwd), agent.jsonlFile);

  const poll = setInterval(() => {
    if (fs.existsSync(agent.jsonlFile)) { clearInterval(poll); startWatch(id); }
  }, JSONL_POLL_MS);
  polls.set(id, poll);
  return id;
}

function closeAgent(id) {
  const a = agents.get(id);
  if (!a) return;
  const w = watchers.get(id); if (w) { w.close(); watchers.delete(id); }
  const p = polls.get(id); if (p) { clearInterval(p); polls.delete(id); }
  try { fs.unwatchFile(a.jsonlFile); } catch {}
  clrTimer(id, permTimers);
  lastNotifyTimes.delete(id);
  clearServers(id);
  pendingClearAgents.delete(id);
  inputBuffers.delete(id);
  pendingTermInput.delete(id);
  inBracketedPaste.delete(id);
  bracketedPasteBuffers.delete(id);
  termBuffers.delete(id);
  const t = terminals.get(id); if (t) { try { t.kill(); } catch {} terminals.delete(id); setTimeout(() => { try { t.destroy(); } catch {} }, 2000); }
  agents.delete(id);
  send({ type: 'agentClosed', id });
  saveState();
}

function archiveAgent(id) {
  const a = agents.get(id);
  if (!a || a.archived) return;
  a.archived = true;
  // Kill pty + watchers to free resources; keep agent metadata + jsonl intact.
  const w = watchers.get(id); if (w) { try { w.close(); } catch {} watchers.delete(id); }
  const p = polls.get(id); if (p) { clearInterval(p); polls.delete(id); }
  try { fs.unwatchFile(a.jsonlFile); } catch {}
  clrTimer(id, permTimers);
  clearServers(id);
  inputBuffers.delete(id);
  pendingTermInput.delete(id);
  inBracketedPaste.delete(id);
  bracketedPasteBuffers.delete(id);
  termBuffers.delete(id);
  const t = terminals.get(id); if (t) { try { t.kill(); } catch {} terminals.delete(id); setTimeout(() => { try { t.destroy(); } catch {} }, 2000); }
  send({ type: 'agentArchived', id });
  saveState();
}

function unarchiveAgent(id) {
  const a = agents.get(id);
  if (!a || !a.archived) return;
  a.archived = false;
  // Reset runtime state so resume starts clean.
  a.fileOffset = 0;
  a.lineBuffer = '';
  a.isWaiting = true;
  a.crashCount = 0;
  a._resumeFailed = false;
  a._resumeHandled = false;
  a._resumeRetrying = false;
  send({ type: 'agentUnarchived', id });
  try { if (fs.existsSync(a.jsonlFile)) { a.fileOffset = fs.statSync(a.jsonlFile).size; startWatch(id); } } catch {}
  spawnTerminal(id);
  saveState();
}

// ── JSONL watching ─────────────────────────────────────
function startWatch(id) {
  const a = agents.get(id); if (!a) return;
  const exists = fs.existsSync(a.jsonlFile);
  logToRenderer(`[startWatch] Agent ${id}: watching ${a.jsonlFile} (exists: ${exists})`);
  // Clean up any existing watchers before creating new ones
  const w = watchers.get(id); if (w) { try { w.close(); } catch {} watchers.delete(id); }
  try { fs.unwatchFile(a.jsonlFile); } catch {}
  const p = polls.get(id); if (p) { clearInterval(p); polls.delete(id); }
  try { watchers.set(id, fs.watch(a.jsonlFile, () => readLines(id))); } catch {}
  try { fs.watchFile(a.jsonlFile, { interval: JSONL_POLL_MS }, () => readLines(id)); } catch {}
  const interval = setInterval(() => { if (!agents.has(id)) { clearInterval(interval); try { fs.unwatchFile(a.jsonlFile); } catch {} return; } readLines(id); }, JSONL_POLL_MS);
  polls.set(id, interval);
  readLines(id);
}

function readLines(id) {
  const a = agents.get(id); if (!a) return;
  try {
    const st = fs.statSync(a.jsonlFile);
    if (st.size < a.fileOffset) { a.fileOffset = 0; a.lineBuffer = ''; } // file truncated/replaced
    if (st.size <= a.fileOffset) {
      // No new data — flush buffered partial line if it's valid JSON (handles race where trailing \n hasn't been written yet)
      if (a.lineBuffer.trim()) { try { JSON.parse(a.lineBuffer); const line = a.lineBuffer; a.lineBuffer = ''; parseLine(id, line); } catch {} }
      return;
    }
    const buf = Buffer.alloc(st.size - a.fileOffset);
    const fd = fs.openSync(a.jsonlFile, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, a.fileOffset); } finally { fs.closeSync(fd); }
    a.fileOffset = st.size;
    const text = a.lineBuffer + buf.toString('utf-8');
    const lines = text.split('\n'); a.lineBuffer = lines.pop() || '';
    if (lines.some(l => l.trim())) { a.crashed = false; clrTimer(id, permTimers); if (a.permSent) { a.permSent = false; send({ type: 'permClear', id }); } }
    for (const line of lines) { if (line.trim()) parseLine(id, line); }
  } catch (e) { logToRenderer(`[readLines] Agent ${id} error: ${e.message} — file: ${a.jsonlFile}`); }
}

function parseLine(id, line) {
  const a = agents.get(id); if (!a) return;
  try {
    const r = JSON.parse(line);
    // Session rename. Claude Code persists /rename as a custom-title line, and
    // agents that rename themselves append the same line — so this is the one
    // source that covers both, and it's what /resume displays.
    if (r.type === 'custom-title' && r.customTitle) {
      if (r.customTitle !== a.title) {
        a.title = r.customTitle;
        a.customName = true;
        send({ type: 'title', id, text: a.title, customName: true });
        saveState();
      }
      return;
    }
    if (r.type === 'assistant') {
      // Extract usage/model regardless of content format (matches restore logic)
      if (r.message?.model) { a.stats.modelFamily = modelFamily(r.message.model); a.stats.model = r.message.model; }
      const u = r.message?.usage;
      if (u) { a.stats.inTok += u.input_tokens || 0; a.stats.outTok += u.output_tokens || 0; a.stats.ctxTok = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0); a.stats.cacheTok += u.cache_creation_input_tokens || 0; a.stats.cacheRead += u.cache_read_input_tokens || 0; send({ type: 'stats', id, stats: a.stats }); }
    }
    if (r.type === 'assistant' && Array.isArray(r.message?.content)) {
      const blocks = r.message.content;
      for (const b of blocks) { if (b.type === 'text' && b.text) { a.lastText = b.text.length > PREVIEW_MAX ? b.text.slice(0, PREVIEW_MAX) + '\u2026' : b.text; send({ type: 'preview', id, text: a.lastText }); } }
      if (blocks.some(b => b.type === 'tool_use')) {
        a.isWaiting = false; a.hadTools = true;
        send({ type: 'status', id, status: 'active' });
        let nonExempt = false;
        for (const b of blocks) {
          if (b.type === 'tool_use' && b.id) {
            const tn = b.name || '', inp = b.input || {}, st = fmtTool(tn, inp);
            a.toolIds.add(b.id); a.toolStatuses.set(b.id, st); a.toolNames.set(b.id, tn); a.turnTools++;
            a.stats.tools[tn] = (a.stats.tools[tn] || 0) + 1;
            if (inp.file_path && ['Read', 'Write', 'Edit'].includes(tn)) a.stats.files++;
            if (!EXEMPT.has(tn)) nonExempt = true;
            if (tn === 'CronCreate') { a.cronCount++; send({ type: 'looping', id, active: true, count: a.cronCount }); }
            if (tn === 'CronDelete') { a.cronCount = Math.max(0, a.cronCount - 1); send({ type: 'looping', id, active: a.cronCount > 0, count: a.cronCount }); }
            const fp = inp.file_path && ['Read', 'Write', 'Edit'].includes(tn) ? inp.file_path : undefined;
            send({ type: 'toolStart', id, toolId: b.id, status: st, name: tn, filePath: fp });
          }
        }
        // These tools always block on a human choice — flag now, don't wait out the timer.
        // They also block under bypassPermissions, which startPermTimer skips.
        if (blocks.some(b => b.type === 'tool_use' && (b.name === 'AskUserQuestion' || b.name === 'ExitPlanMode'))) {
          clrTimer(id, permTimers); a.permSent = true; send({ type: 'perm', id }); notifyPermission(id, a);
        } else if (nonExempt) startPermTimer(id);
      }
    } else if (r.type === 'user') {
      const c = r.message?.content;
      if (Array.isArray(c)) {
        if (c.some(b => b.type === 'tool_result')) {
          for (const b of c) {
            if (b.type === 'tool_result' && b.tool_use_id) {
              const tid = b.tool_use_id, cn = a.toolNames.get(tid);
              // Scan Bash tool output for localhost server URLs
              if (cn === 'Bash' && typeof b.content === 'string') scanForServers(id, b.content);
              if (cn === 'Task' || cn === 'Agent') { a.subToolIds.delete(tid); a.subToolNames.delete(tid); }
              a.toolIds.delete(tid); a.toolStatuses.delete(tid); a.toolNames.delete(tid);
              setTimeout(() => send({ type: 'toolDone', id, toolId: tid }), TOOL_DONE_DELAY_MS);
            }
          }
          if (a.toolIds.size === 0) { a.hadTools = false; }
        } else {
          const txt = c.filter(b => b.type === 'text').map(b => b.text || '').join('').trim();
          if (txt) { setPrompt(id, a, txt); }
          clrActivity(id); a.hadTools = false; a.turnTools = 0;
        }
      } else if (typeof c === 'string' && c.trim()) {
        setPrompt(id, a, c);
        clrActivity(id); a.hadTools = false; a.turnTools = 0;
      }
    } else if (r.type === 'system' && r.subtype === 'compact_boundary') {
      // Context was compacted — reset ctxTok so bar reflects the reduction immediately
      // (next assistant message will set the real post-compact value)
      a.stats.ctxTok = 0;
      a.compacting = false;
      send({ type: 'stats', id, stats: a.stats });
      send({ type: 'compacting', id, active: false });
    } else if (r.type === 'system' && r.subtype === 'turn_duration') {
      clrTimer(id, permTimers);
      a.stats.turns++; a.stats.durMs += r.durationMs || 0;
      send({ type: 'stats', id, stats: a.stats });
      if (a.toolIds.size > 0) { a.toolIds.clear(); a.toolStatuses.clear(); a.toolNames.clear(); a.subToolIds.clear(); a.subToolNames.clear(); send({ type: 'toolsClear', id }); }
      a.isWaiting = true; a.permSent = false; a.hadTools = false; a.turnTools = 0; a.crashCount = 0; a.spinnerText = '';
      // Orphaned process finished its turn — safe to spawn a real terminal now
      if (a.orphanAlive) {
        a.orphanAlive = false;
        console.log(`[Overlord] Orphaned Claude for agent ${id} finished — ready for terminal`);
        send({ type: 'termData', id, data: '\x1b[32m[Previous session turn completed. Click to reconnect.]\x1b[0m\r\n' });
      }
      send({ type: 'status', id, status: 'waiting' });
      flushPeerMsgs(id);
      if (a.stats.turns === 1 || a.stats.turns % TITLE_REGEN_TURNS === 0) generateSummaryTitle(id);
    } else if (r.type === 'progress') {
      const ptid = r.parentToolUseID, d = r.data;
      if (ptid && d) {
        if (d.type === 'bash_progress' || d.type === 'mcp_progress') {
          if (a.toolIds.has(ptid)) startPermTimer(id);
          // Scan bash/mcp progress output for localhost server URLs (background tasks like npm run dev)
          if (d.type === 'bash_progress') { const pt = d.output || d.content || d.text || ''; if (pt) scanForServers(id, pt); }
        }
        if (d.type === 'agent_progress' && a.toolIds.has(ptid)) {
          startPermTimer(id);
          const ptn = a.toolNames.get(ptid);
          if (ptn === 'Task' || ptn === 'Agent') {
            const msg = d.message, mt = msg?.type, inner = msg?.message, content = inner?.content;
            if (Array.isArray(content)) {
              if (mt === 'assistant') {
                for (const b of content) {
                  if (b.type === 'tool_use' && b.id) {
                    const tn = b.name || '', st = fmtTool(tn, b.input || {});
                    let subs = a.subToolIds.get(ptid); if (!subs) { subs = new Set(); a.subToolIds.set(ptid, subs); } subs.add(b.id);
                    let names = a.subToolNames.get(ptid); if (!names) { names = new Map(); a.subToolNames.set(ptid, names); } names.set(b.id, tn);
                    send({ type: 'subToolStart', id, parentToolId: ptid, toolId: b.id, status: st, name: tn });
                  }
                }
              } else if (mt === 'user') {
                for (const b of content) {
                  if (b.type === 'tool_result' && b.tool_use_id) {
                    const subs = a.subToolIds.get(ptid); if (subs) subs.delete(b.tool_use_id);
                    const names = a.subToolNames.get(ptid); if (names) names.delete(b.tool_use_id);
                    setTimeout(() => send({ type: 'subToolDone', id, parentToolId: ptid, toolId: b.tool_use_id }), TOOL_DONE_DELAY_MS);
                  }
                }
              }
            }
          }
        }
      }
    }
  } catch {}
  // Emit timeline events for the focused agent
  if (id === timelineAgentId) {
    const tlEvents = parseLineForTimeline(line);
    if (tlEvents) for (const ev of tlEvents) send({ type: 'timelineEvent', id, event: ev });
  }
}

// ── JSONL file scanning (detect /clear, session switches) ──
function registerKnownJsonl(projectDir, filePath) {
  let known = knownJsonlFiles.get(projectDir);
  if (!known) {
    // First time seeing this dir — seed with all existing JSONL files to avoid false detections
    known = new Set();
    try {
      for (const f of fs.readdirSync(projectDir)) {
        if (f.endsWith('.jsonl')) known.add(path.join(projectDir, f));
      }
    } catch {}
    knownJsonlFiles.set(projectDir, known);
  }
  known.add(filePath);
}

function scanForNewJsonlFiles() {
  // Group agents by projectDir
  const byDir = new Map(); // projectDir -> [agentId, ...]
  for (const [id, a] of agents) {
    const dir = claudeDir(a.cwd);
    let arr = byDir.get(dir); if (!arr) { arr = []; byDir.set(dir, arr); }
    arr.push(id);
  }
  for (const [dir, ids] of byDir) {
    let files;
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f)); } catch { continue; }
    let known = knownJsonlFiles.get(dir);
    if (!known) { known = new Set(); knownJsonlFiles.set(dir, known); }
    for (const file of files) {
      if (known.has(file)) continue;
      known.add(file);
      // New JSONL found — find which agent ran /clear
      let targetId = null;
      const candidates = [];
      for (const id of ids) {
        if (!terminals.has(id)) continue;
        const ag = agents.get(id);
        if (!ag) continue;
        candidates.push(id);
      }
      if (candidates.length === 1) {
        targetId = candidates[0];
      } else if (candidates.length > 1) {
        // Primary: use pendingClearAgents to identify which agent ran /clear
        for (const id of candidates) {
          if (pendingClearAgents.has(id)) { targetId = id; pendingClearAgents.delete(id); break; }
        }
        // No fallback — when multiple agents share a CWD and we can't
        // identify which one ran /clear, skip reassignment to avoid
        // pointing the wrong agent at someone else's JSONL file.
        if (targetId === null) {
          console.log(`[Overlord] New JSONL ${path.basename(file)} in shared dir with ${candidates.length} candidates — skipping (no pending /clear match)`);
        }
      }
      if (targetId !== null) {
        console.log(`[Overlord] New JSONL detected: ${path.basename(file)}, reassigning agent ${targetId}`);
        reassignAgentToFile(targetId, file);
      }
    }
  }
}

// After /resume the agent is writing to the picked chat's existing JSONL, so it's
// still tailing — and titled after — the session it left. Re-point it at whichever
// other transcript in the project dir went live since the /resume.
// ponytail: mtime is the only signal Claude Code leaves; a session started outside
// Overlord in the same dir inside the 3-min window could be picked by mistake.
function reconcileResumedAgents() {
  for (const [id, since] of pendingResumeAgents) {
    const a = agents.get(id);
    if (!a || !terminals.has(id) || Date.now() - since > RESUME_WINDOW_MS) { pendingResumeAgents.delete(id); continue; }
    const dir = claudeDir(a.cwd);
    const owned = new Set();
    for (const [oid, o] of agents) if (oid !== id) owned.add(o.jsonlFile);
    const entries = [];
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const file = path.join(dir, f);
        try { entries.push({ file, mtimeMs: fs.statSync(file).mtimeMs }); } catch {}
      }
    } catch { continue; }
    const file = pickResumedFile({ entries, since, current: a.jsonlFile, owned });
    if (!file) continue;
    pendingResumeAgents.delete(id);
    pendingClearAgents.delete(id); // resume landed in an existing file, not a fresh one
    console.log(`[Overlord] /resume detected: agent ${id} -> ${path.basename(file)}`);
    reassignAgentToFile(id, file);
  }
}

// Newest chat name from a session's JSONL — user /rename (custom-title) wins over
// the auto-generated ai-title. '' if neither (e.g. a fresh /clear session).
function readSessionTitle(file) {
  let custom = '', ai = '';
  try {
    for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
      if (!line.includes('"custom-title"') && !line.includes('"ai-title"')) continue;
      try {
        const r = JSON.parse(line);
        if (r.type === 'custom-title' && r.customTitle) custom = r.customTitle;
        else if (r.type === 'ai-title' && r.aiTitle) ai = r.aiTitle;
      } catch {}
    }
  } catch {}
  return custom || ai;
}

function reassignAgentToFile(id, newFilePath) {
  const a = agents.get(id); if (!a) return;
  // Stop old watchers
  const w = watchers.get(id); if (w) { try { w.close(); } catch {} watchers.delete(id); }
  const p = polls.get(id); if (p) { clearInterval(p); polls.delete(id); }
  try { fs.unwatchFile(a.jsonlFile); } catch {}
  // Clear activity
  clrTimer(id, permTimers);
  a.toolIds.clear(); a.toolStatuses.clear(); a.toolNames.clear();
  a.subToolIds.clear(); a.subToolNames.clear();
  a.isWaiting = false; a.permSent = false; a.hadTools = false; a.turnTools = 0;
  send({ type: 'toolsClear', id });
  // Reset stats (new session = fresh context)
  const oldModel = a.stats.modelFamily;
  a.stats = { inTok: 0, outTok: 0, cacheTok: 0, cacheRead: 0, ctxTok: 0, turns: 0, durMs: 0, tools: {}, files: 0, modelFamily: oldModel };
  send({ type: 'stats', id, stats: a.stats });
  // Reset title, prompt, preview for new session. On /resume, Claude forks a new
  // JSONL that already carries the resumed chat's name — adopt it as a sticky title
  // so the card shows which chat you're back in. /clear's file has no title yet.
  const resumedTitle = readSessionTitle(newFilePath);
  if (resumedTitle) {
    a.title = resumedTitle;
    a.customName = true;
    send({ type: 'title', id, text: a.title, customName: true });
  } else if (!a.customName) {
    a.title = '';
    send({ type: 'title', id, text: '' });
  }
  a.lastPrompt = '';
  a.lastText = '';
  a.promptHistory = [];
  send({ type: 'prompt', id, text: '' });
  send({ type: 'preview', id, text: '' });
  send({ type: 'promptHistory', id, prompts: [] });
  // After /clear, agent is idle at prompt — mark as waiting (done)
  a.isWaiting = true;
  send({ type: 'status', id, status: 'waiting' });
  // Switch to new file
  const newSessionId = path.basename(newFilePath, '.jsonl');
  a.sessionId = newSessionId;
  a.jsonlFile = newFilePath;
  a.fileOffset = 0;
  a.lineBuffer = '';
  saveState();
  // Start watching new file
  startWatch(id);
}

// ── Timers ─────────────────────────────────────────────
function clrTimer(id, map) { const t = map.get(id); if (t) { clearTimeout(t); map.delete(id); } }
function clrActivity(id) { const a = agents.get(id); if (!a) return; a.toolIds.clear(); a.toolStatuses.clear(); a.toolNames.clear(); a.subToolIds.clear(); a.subToolNames.clear(); a.isWaiting = false; a.permSent = false; clrTimer(id, permTimers); send({ type: 'toolsClear', id }); send({ type: 'status', id, status: 'active' }); }
// startWaitTimer removed — status:'waiting' now comes exclusively from turn_duration (authoritative)
function startPermTimer(id) { if (settings.bypassPermissions) return; clrTimer(id, permTimers); permTimers.set(id, setTimeout(() => { permTimers.delete(id); const a = agents.get(id); if (!a) return; let ne = false; for (const tid of a.toolIds) { if (!EXEMPT.has(a.toolNames.get(tid) || '')) { ne = true; break; } } if (ne) { a.permSent = true; send({ type: 'perm', id }); notifyPermission(id, a); } }, PERMISSION_TIMER_MS)); }

const lastNotifyTimes = new Map(); // per-agent throttle
const NOTIFY_THROTTLE_MS = 3000;

function notifyPermission(id, a) {
  if (!settings.notifications) return;
  const now = Date.now();
  if (now - (lastNotifyTimes.get(id) || 0) < NOTIFY_THROTTLE_MS) return;
  lastNotifyTimes.set(id, now);
  // Flash taskbar if window not focused
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
    mainWindow.flashFrame(true);
  }
  // Desktop notification
  if (Notification.isSupported()) {
    const title = a.title || 'Agent ' + id;
    let toolName = '';
    for (const tid of a.toolIds) {
      if (!EXEMPT.has(a.toolNames.get(tid) || '')) { toolName = a.toolStatuses.get(tid) || a.toolNames.get(tid) || ''; break; }
    }
    const n = new Notification({ title: 'Needs approval', body: `${title}${toolName ? ': ' + toolName : ''}`, silent: !settings.notificationSound });
    n.on('click', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
        send({ type: 'focusFromNotification', id });
      }
    });
    n.show();
  }
}

// ── PR notifications ───────────────────────────────────
const { execFile } = require('child_process');
const PR_REPO_RE = /^[\w.-]+\/[\w.-]+$/;

// A GUI-launched Electron app inherits the PATH explorer.exe had at login, so a gh
// installed since then stays invisible until reboot. Prepend its install dir so the
// bare `gh` spawns below resolve without one.
function repairGhPath() {
  if (process.platform !== 'win32') return null;
  const dirs = [
    'C:\\Program Files\\GitHub CLI',
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'GitHub CLI'),
  ];
  const cur = (process.env.PATH || '').split(';');
  for (const d of dirs) {
    if (!d || cur.includes(d)) continue;
    try {
      if (fs.existsSync(path.join(d, 'gh.exe'))) {
        process.env.PATH = d + ';' + process.env.PATH;
        return d;
      }
    } catch {}
  }
  return null;
}
repairGhPath();

// cmd.exe reports a missing binary as "is not recognized"; a direct spawn reports
// ENOENT. Both mean gh is absent, which is not the auth failure we used to claim.
// The code drives which one-click fix the renderer offers.
function ghErrCode(err) {
  const m = (err && err.message) || String(err || '');
  if (/not recognized|ENOENT|cannot find/i.test(m)) return 'missing';
  if (/gh auth login|not logged in|authentication token|HTTP 401/i.test(m)) return 'auth';
  return null;
}
function ghErr(err) {
  const m = (err && err.message) || String(err || '');
  const c = ghErrCode(err);
  if (c === 'missing') return 'GitHub CLI (gh) is not installed.';
  if (c === 'auth') return 'GitHub CLI is not logged in.';
  return m;
}
function prKey(repo, number) { return `${repo}#${number}`; }
// Returns keys present now but not in the seen set.
function diffNewPRKeys(currentKeys, seenKeys) {
  const seen = new Set(seenKeys);
  return currentKeys.filter(k => !seen.has(k));
}

// Map a GraphQL StatusCheckRollup.state to 'pass' | 'fail' | 'pending' | 'none'.
function rollupState(s) {
  if (!s) return 'none';
  if (s === 'SUCCESS') return 'pass';
  if (s === 'PENDING' || s === 'EXPECTED') return 'pending';
  return 'fail'; // FAILURE, ERROR
}

let prTimer = null;
let prSeenSeeded = false;
let prGhErrorLogged = false;
let ghLogin = null;

// Login of the authenticated gh user, cached after first lookup.
function fetchGhLogin() {
  return new Promise((resolve) => {
    if (ghLogin) return resolve(ghLogin);
    execFile('gh', ['api', 'user', '--jq', '.login'],
      { timeout: 15000, windowsHide: true, shell: process.platform === 'win32' }, (err, stdout) => {
        const v = err ? '' : stdout.trim();
        ghLogin = v || null; // only cache a real login; retry next poll if it failed
        resolve(v);
      });
  });
}

// One GraphQL call for ALL watched repos (one gh process, not one per repo).
// Returns { prs, failed[], error? }. Parses stdout even on non-zero exit so a
// single bad repo (null alias + GraphQL error) doesn't lose the others.
function fetchAllPRs(repos) {
  return new Promise((resolve) => {
    const valid = repos.filter(r => PR_REPO_RE.test(r));
    if (!valid.length) return resolve({ prs: [], failed: [] });
    const parts = valid.map((r, i) => {
      const [owner, name] = r.split('/');
      return `r${i}: repository(owner:${JSON.stringify(owner)}, name:${JSON.stringify(name)}) { `
        + `pullRequests(states: OPEN, first: 100) { nodes { number title url isDraft createdAt `
        + `author { login } reviewDecision mergeable mergeStateStatus headRefName baseRefName `
        + `reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } } } } `
        + `latestReviews(first: 20) { nodes { author { login } state } } `
        + `commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } }`;
    });
    const query = `query {\n${parts.join('\n')}\n}`;
    let out = '', errbuf = '', proc, done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(to); resolve(v); };
    try {
      proc = spawn('gh', ['api', 'graphql', '-F', 'query=@-'], { windowsHide: true, shell: process.platform === 'win32' });
    } catch (e) { return resolve({ prs: [], failed: valid, error: ghErr(e), errorCode: ghErrCode(e) }); }
    const to = setTimeout(() => { try { proc.kill(); } catch {} finish({ prs: [], failed: valid, error: 'timeout' }); }, 25000);
    proc.on('error', (e) => finish({ prs: [], failed: valid, error: ghErr(e), errorCode: ghErrCode(e) }));
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => errbuf += d);
    proc.on('close', () => {
      let json;
      // With shell:true a missing gh fails via cmd.exe's stderr, not an 'error' event.
      try { json = JSON.parse(out); } catch {
        const e = { message: (errbuf || 'gh graphql failed').trim().slice(0, 200) };
        return finish({ prs: [], failed: valid, error: ghErr(e), errorCode: ghErrCode(e) });
      }
      const data = json.data || {};
      const prs = [], failed = [];
      valid.forEach((r, i) => {
        const node = data['r' + i];
        if (!node) { failed.push(r); return; }
        for (const pr of (node.pullRequests && node.pullRequests.nodes) || []) {
          const mine = !!ghLogin && pr.author && pr.author.login === ghLogin;
          if (pr.isDraft) continue;
          if (pr.reviewDecision === 'APPROVED' && !mine) continue; // hide approved unless mine
          const rollup = pr.commits && pr.commits.nodes[0] && pr.commits.nodes[0].commit.statusCheckRollup;
          const requested = !!ghLogin && ((pr.reviewRequests && pr.reviewRequests.nodes) || [])
            .some(n => n.requestedReviewer && n.requestedReviewer.login === ghLogin);
          const reviews = (pr.latestReviews && pr.latestReviews.nodes) || [];
          const approvedBy = reviews.filter(r => r.state === 'APPROVED' && r.author).map(r => r.author.login);
          const changesBy = reviews.filter(r => r.state === 'CHANGES_REQUESTED' && r.author).map(r => r.author.login);
          prs.push({
            key: prKey(r, pr.number), repo: r, number: pr.number, title: pr.title, url: pr.url,
            author: (pr.author && pr.author.login) || '',
            reviewDecision: pr.reviewDecision || '', mine,
            checks: rollupState(rollup && rollup.state),
            mergeable: pr.mergeable || 'UNKNOWN', mergeState: pr.mergeStateStatus || '',
            requested, createdAt: pr.createdAt || '', approvedBy, changesBy,
            headRef: pr.headRefName || '', baseRef: pr.baseRefName || '',
          });
        }
      });
      finish({ prs, failed });
    });
    try { proc.stdin.write(query); proc.stdin.end(); } catch {}
  });
}

async function pollPRs() {
  const cfg = settings.prSettings;
  if (!cfg || !cfg.enabled || !Array.isArray(cfg.repos) || cfg.repos.length === 0) return;
  await fetchGhLogin();
  const res = await fetchAllPRs(cfg.repos);
  const failedRepos = res.failed || [];
  const validCount = cfg.repos.filter(r => PR_REPO_RE.test(r)).length;
  if (res.prs.length === 0 && (res.error || failedRepos.length >= validCount)) {
    // Total failure — keep last known list in renderer, don't notify.
    const emsg = res.error || ('Couldn\'t reach: ' + failedRepos.join(', '));
    if (!prGhErrorLogged) { console.log('[Overlord] PR poll failed:', emsg); prGhErrorLogged = true; }
    send({ type: 'prList', prs: null, error: emsg, errorCode: res.errorCode || null });
    return;
  }
  if (failedRepos.length && !prGhErrorLogged) {
    console.log('[Overlord] PR poll: some repos failed:', failedRepos.join(', '));
    prGhErrorLogged = true;
  }
  if (!failedRepos.length) prGhErrorLogged = false;
  const prs = res.prs;
  const currentKeys = prs.map(p => p.key);
  const muted = new Set(settings.prMuted || []);
  const mutedRepos = new Set(settings.prMutedRepos || []);
  const nowMs = Date.now();
  const snoozes = settings.prSnoozed || {};
  for (const k of Object.keys(snoozes)) if (snoozes[k] <= nowMs) delete snoozes[k]; // drop expired
  settings.prSnoozed = snoozes;
  prs.forEach(p => {
    p.muted = muted.has(p.key);
    p.repoMuted = mutedRepos.has(p.repo);
    p.snoozed = snoozes[p.key] > nowMs;
    p.snoozeUntil = snoozes[p.key] || 0;
  });
  const seen = settings.prSeen || [];
  if (!prSeenSeeded && seen.length === 0) {
    // First run with no history: seed silently, no toasts for pre-existing PRs.
    prSeenSeeded = true;
  } else {
    for (const k of diffNewPRKeys(currentKeys, seen)) {
      const pr = prs.find(p => p.key === k);
      if (!pr || pr.muted || pr.repoMuted || pr.snoozed) continue; // muted/snoozed doesn't notify
      notifyNewPR(pr);
    }
  }
  // Notify when MY PR's review state changes (approved / changes requested).
  const prevDecisions = settings.prDecisions || {};
  for (const p of prs) {
    if (!p.mine || p.muted || p.repoMuted || p.snoozed) continue;
    const prev = prevDecisions[p.key];
    if (prev === undefined) continue; // no prior state — a new PR, not a transition
    if (p.reviewDecision === 'APPROVED' && prev !== 'APPROVED') notifyPrDecision(p, 'approved');
    else if (p.reviewDecision === 'CHANGES_REQUESTED' && prev !== 'CHANGES_REQUESTED') notifyPrDecision(p, 'changes');
  }
  settings.prDecisions = {};
  for (const p of prs) settings.prDecisions[p.key] = p.reviewDecision;
  settings.prSeen = currentKeys;
  // Drop mutes for PRs that are no longer open (merged/closed) — keeps the list tidy.
  settings.prMuted = (settings.prMuted || []).filter(k => currentKeys.includes(k));
  prSeenSeeded = true;
  saveState();
  send({ type: 'prList', prs, error: null, failedRepos });
}

function notifyNewPR(pr) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: `New PR · ${pr.repo}`, body: `#${pr.number} ${pr.title}`, silent: true });
  n.on('click', () => shell.openExternal(pr.url).catch(() => {}));
  n.show();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.flashFrame(true);
}

function notifyPrDecision(pr, kind) {
  if (!Notification.isSupported()) return;
  const title = kind === 'approved' ? `✅ PR approved · ${pr.repo}` : `📝 Changes requested · ${pr.repo}`;
  const n = new Notification({ title, body: `#${pr.number} ${pr.title}`, silent: true });
  n.on('click', () => shell.openExternal(pr.url).catch(() => {}));
  n.show();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.flashFrame(true);
}

function armPrTimer() {
  if (prTimer) { clearInterval(prTimer); prTimer = null; }
  const cfg = settings.prSettings;
  if (!cfg || !cfg.enabled) return;
  const sec = Math.max(30, Number(cfg.intervalSec) || 60);
  pollPRs();
  prTimer = setInterval(pollPRs, sec * 1000);
}

// ── GitHub Actions tracking ───────────────────────────
const { runState, nextPollDelay, diffNewFailures, REPO_RE: WF_REPO_RE } = require('./actions-core');
const WF_FILE_RE = /^[\w.-]+\.ya?ml$/i;
let actionsTimer = null;
let actionsGhErrorLogged = false;

function wfKey(repo, file) { return `${repo}/${file}`; }

// Keep only entries that survive a round trip through the two regexes — this is
// the trust boundary for strings that get spliced into a gh api path.
function sanitizeWorkflows(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).reduce((acc, w) => {
    const repo = String((w && w.repo) || '').trim();
    const file = String((w && w.file) || '').trim();
    if (!WF_REPO_RE.test(repo) || !WF_FILE_RE.test(file)) return acc;
    const k = wfKey(repo, file);
    if (seen.has(k)) return acc;
    seen.add(k);
    acc.push({ repo, file, name: String((w && w.name) || '').slice(0, 120) });
    return acc;
  }, []);
}

function ghJson(args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile('gh', args, { timeout, windowsHide: true, shell: process.platform === 'win32', maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) return resolve({ error: ghErr(err), errorCode: ghErrCode(err) });
        try { resolve({ data: JSON.parse(stdout) }); }
        catch (e) { resolve({ error: ghErr(err || e), errorCode: ghErrCode(err || e) }); }
      });
  });
}

// Latest run on any branch for one workflow. per_page=1 keeps it to a single
// row; a workflow that has never run comes back with an empty list, not an error.
async function fetchWorkflowRun(w) {
  const base = { key: wfKey(w.repo, w.file), repo: w.repo, file: w.file, name: w.name || w.file };
  const res = await ghJson(['api', `/repos/${w.repo}/actions/workflows/${w.file}/runs?per_page=1`]);
  if (res.error) {
    return { ...base, state: 'none', error: res.error, errorCode: res.errorCode || null,
      url: `https://github.com/${w.repo}/actions/workflows/${w.file}` };
  }
  const run = (res.data && res.data.workflow_runs && res.data.workflow_runs[0]) || null;
  const actorOf = (r) => (r.actor && r.actor.login) || (r.triggering_actor && r.triggering_actor.login) || '';
  if (!run) {
    return { ...base, state: 'none', url: `https://github.com/${w.repo}/actions/workflows/${w.file}` };
  }
  return {
    ...base,
    // run.name is the workflow's own `name:` from GitHub — the alias the user sees
    // there. It wins over anything we cached at add-time, which may just be the file.
    name: run.name || w.name || w.file,
    state: runState(run),
    conclusion: run.conclusion || '',
    status: run.status || '',
    branch: run.head_branch || '',
    actor: actorOf(run),
    // false ONLY when we know the login and it differs — an unresolved login
    // leaves this undefined, which the badge treats as mine (fails loud).
    mine: ghLogin ? actorOf(run) === ghLogin : undefined,
    event: run.event || '',
    runNumber: run.run_number || 0,
    title: run.display_title || run.head_commit && run.head_commit.message || '',
    startedAt: run.run_started_at || run.created_at || '',
    updatedAt: run.updated_at || '',
    url: run.html_url || `https://github.com/${w.repo}/actions/workflows/${w.file}`,
  };
}

async function pollActions() {
  const cfg = settings.actionsSettings;
  const wfs = sanitizeWorkflows(cfg && cfg.workflows);
  if (!cfg || !cfg.enabled || !wfs.length) return [];
  await fetchGhLogin(); // needed to tell my failed deploys from everyone else's
  const rows = await Promise.all(wfs.map(fetchWorkflowRun));
  const failed = rows.filter(r => r.error);
  if (failed.length === rows.length) {
    // Every workflow failed — almost always gh missing/logged out, not N bad repos.
    const emsg = failed[0].error;
    if (!actionsGhErrorLogged) { console.log('[Overlord] Actions poll failed:', emsg); actionsGhErrorLogged = true; }
    send({ type: 'actionsList', runs: null, error: emsg, errorCode: failed[0].errorCode || null });
    return rows;
  }
  actionsGhErrorLogged = false;
  // Notify only on the transition into failure — a run that was already red last
  // poll has been reported once, and a first sighting isn't a transition at all.
  const prevStates = settings.actionsStates || {};
  for (const r of diffNewFailures(rows, prevStates)) notifyActionFailed(r);
  settings.actionsStates = {};
  for (const r of rows) if (!r.error) settings.actionsStates[r.key] = r.state;
  saveState();
  send({ type: 'actionsList', runs: rows, error: null });
  return rows;
}

function notifyActionFailed(r) {
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: `❌ Action failed · ${r.repo}`,
    body: `${r.name || r.file}${r.branch ? ' · ' + r.branch : ''}`,
    silent: true,
  });
  n.on('click', () => shell.openExternal(r.url).catch(() => {}));
  n.show();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.flashFrame(true);
}

// setTimeout, not setInterval: the delay depends on what the last poll saw, so
// a deploy in flight is picked up every 10s and an idle board every intervalSec.
function armActionsTimer() {
  if (actionsTimer) { clearTimeout(actionsTimer); actionsTimer = null; }
  const cfg = settings.actionsSettings;
  if (!cfg || !cfg.enabled) return;
  const tick = async () => {
    let rows = [];
    try { rows = await pollActions(); } catch (e) { console.log('[Overlord] Actions poll error:', e.message); }
    const c = settings.actionsSettings;
    if (!c || !c.enabled) return;
    actionsTimer = setTimeout(tick, nextPollDelay(rows, c.intervalSec));
  };
  tick();
}

// ── Transcript export ─────────────────────────────────
async function exportTranscript(id) {
  const a = agents.get(id);
  if (!a) return;
  if (!fs.existsSync(a.jsonlFile)) return;
  const content = await fs.promises.readFile(a.jsonlFile, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  const turns = [];
  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      if (r.type === 'user') {
        const c = r.message?.content;
        let txt = '';
        if (typeof c === 'string') txt = c.trim();
        else if (Array.isArray(c)) txt = c.filter(b => b.type === 'text').map(b => b.text || '').join('\n').trim();
        if (txt) turns.push({ role: 'user', text: txt });
      } else if (r.type === 'assistant' && Array.isArray(r.message?.content)) {
        const texts = [], tools = [];
        for (const b of r.message.content) {
          if (b.type === 'text' && b.text) texts.push(b.text);
          else if (b.type === 'tool_use') tools.push(b.name || 'unknown');
        }
        if (texts.length || tools.length) turns.push({ role: 'assistant', text: texts.join('\n'), tools });
      }
    } catch {}
  }
  const title = a.title || 'Untitled session';
  const stats = a.stats;
  const fmtDur = (ms) => { const s = Math.floor(ms / 1000); if (s < 60) return s + 's'; const m = Math.floor(s / 60); if (m < 60) return m + 'm ' + (s % 60) + 's'; return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; };
  let md = `# ${title}\n\n`;
  md += `**Project:** ${a.cwd}  \n`;
  md += `**Session:** ${a.sessionId}  \n`;
  md += `**Turns:** ${stats.turns} | **Duration:** ${fmtDur(stats.durMs)} | **Tokens:** ${(stats.inTok + stats.outTok).toLocaleString()}\n\n`;
  if (Object.keys(stats.tools).length > 0) {
    md += `## Tool Usage\n\n| Tool | Count |\n|------|-------|\n`;
    for (const [name, count] of Object.entries(stats.tools).sort((x, y) => y[1] - x[1])) md += `| ${name} | ${count} |\n`;
    md += '\n';
  }
  md += `## Conversation\n\n`;
  for (const t of turns) {
    if (t.role === 'user') md += `### User\n\n${t.text}\n\n`;
    else {
      md += `### Assistant`;
      if (t.tools && t.tools.length) md += ` *(used: ${t.tools.join(', ')})*`;
      md += `\n\n${t.text}\n\n`;
    }
  }
  const safeName = title.replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '-').toLowerCase();
  const defaultName = (safeName || 'session-export') + '.md';
  dialog.showSaveDialog(mainWindow, { title: 'Export Transcript', defaultPath: defaultName, filters: [{ name: 'Markdown', extensions: ['md'] }] })
    .then(r => { if (!r.canceled && r.filePath) fs.writeFileSync(r.filePath, md, 'utf-8'); });
}

// ── Usage polling (via API rate-limit headers) ────────
let usageInFlight = false;
let lastUsage = null;

function getApiKey() {
  try {
    const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    return creds?.claudeAiOauth?.accessToken || null;
  } catch { return null; }
}

// ── Account switching ─────────────────────────────────
function loadAccounts() {
  try {
    if (!fs.existsSync(ACCOUNTS_PATH)) return { accounts: [], activeLabel: null };
    return JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8'));
  } catch { return { accounts: [], activeLabel: null }; }
}

function saveAccountsFile(data) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(data, null, 2));
}

function getAccountMeta() {
  try {
    const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    const oauth = creds?.claudeAiOauth;
    if (!oauth) return {};
    return {
      subscriptionType: oauth.subscriptionType || null,
      rateLimitTier: oauth.rateLimitTier || null,
    };
  } catch { return {}; }
}

// `claude auth status` spawns the whole CLI (~1-3s) — never run it synchronously,
// it used to freeze the app during startup. Fetch in background, push accountInfo
// to the renderer when it lands.
let _cachedAuthStatus = null;
let _authStatusChecked = false;
function refreshAuthStatus(force) {
  if (_authStatusChecked && !force) return Promise.resolve();
  _authStatusChecked = true;
  return new Promise(resolve => {
    execFile('claude', ['auth', 'status'], { timeout: 15000, windowsHide: true, shell: process.platform === 'win32' }, (err, stdout) => {
      if (!err) {
        try {
          _cachedAuthStatus = JSON.parse(stdout.trim());
          send({ type: 'accountInfo', ...getCurrentAccountInfo() });
        } catch {}
      }
      resolve();
    });
  });
}

function getAccountEmail() {
  if (!_cachedAuthStatus) refreshAuthStatus();
  return _cachedAuthStatus?.email || null;
}

function getCurrentAccountInfo() {
  const data = loadAccounts();
  const meta = getAccountMeta();
  const email = getAccountEmail();
  const hasCredentials = !!getApiKey();
  return {
    activeLabel: data.activeLabel || null,
    email,
    meta,
    hasCredentials,
    accounts: data.accounts.map(a => ({ label: a.label, email: a.email, meta: a.meta })),
  };
}

function fetchUsage() {
  if (usageInFlight) return;
  const apiKey = getApiKey();
  if (!apiKey) {
    console.log('[Overlord] No API key found in credentials');
    return;
  }
  usageInFlight = true;
  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1,
    messages: [{ role: 'user', content: '.' }]
  });
  const req = https.request({
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'authorization': `Bearer ${apiKey}`,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    },
    timeout: USAGE_TIMEOUT_MS,
  }, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      usageInFlight = false;
      const headers = res.headers;
      const usage = {};
      const h5 = parseFloat(headers['anthropic-ratelimit-unified-5h-utilization']);
      const d7 = parseFloat(headers['anthropic-ratelimit-unified-7d-utilization']);
      if (!isNaN(h5)) usage.hourly = +(h5 * 100).toFixed(1);
      if (!isNaN(d7)) usage.weekly = +(d7 * 100).toFixed(1);
      // Grab reset timestamps
      const r5 = headers['anthropic-ratelimit-unified-5h-reset'];
      const r7 = headers['anthropic-ratelimit-unified-7d-reset'];
      if (r5) usage.hourlyReset = parseInt(r5, 10) * 1000;
      if (r7) usage.weeklyReset = parseInt(r7, 10) * 1000;
      if (Object.keys(usage).length > 0) {
        usage.fetchedAt = Date.now();
        lastUsage = usage;
        send({ type: 'usage', usage });
        console.log('[Overlord] Usage fetched:', JSON.stringify(usage));
      } else {
        console.log('[Overlord] No rate-limit headers in response');
      }
    });
  });
  req.on('error', (e) => {
    usageInFlight = false;
    console.log('[Overlord] Usage fetch error:', e.message);
  });
  req.on('timeout', () => {
    usageInFlight = false;
    req.destroy();
    console.log('[Overlord] Usage fetch timed out');
  });
  req.write(body);
  req.end();
}

// ── Team prompt building ──────────────────────────────
function buildTeamPrompt(task, roles) {
  let prompt = `Create an agent team to accomplish this task:\n\n${task}\n\n`;
  if (roles && roles.length > 0) {
    prompt += 'Team members should have these roles:\n';
    for (const role of roles) {
      prompt += `- ${role.name}: ${role.description}\n`;
    }
    prompt += '\n';
  }
  prompt += 'Use the agent teams feature to coordinate the work. Create the team, assign tasks, and begin working.';
  return prompt;
}

// ── Team detection ────────────────────────────────────
function scanTeams() {
  try {
    if (!fs.existsSync(TEAMS_DIR)) return;
    const teamDirs = fs.readdirSync(TEAMS_DIR);
    // Build sessionId -> agentId lookup from our agents
    const sessionToAgent = new Map();
    for (const [id, a] of agents) sessionToAgent.set(a.sessionId, id);

    for (const teamName of teamDirs) {
      const configPath = path.join(TEAMS_DIR, teamName, 'config.json');
      if (!fs.existsSync(configPath)) continue;
      let config;
      try { config = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch { continue; }
      if (!config.leadSessionId || !config.members) continue;

      // Match team to one of our agents via leadSessionId
      const leadAgentId = sessionToAgent.get(config.leadSessionId);
      if (leadAgentId === undefined) continue; // not our agent

      // Read tasks
      let taskList = [];
      const tasksDir = path.join(TASKS_DIR, teamName);
      if (fs.existsSync(tasksDir)) {
        try {
          const taskFiles = fs.readdirSync(tasksDir).filter(f => f.endsWith('.json'));
          for (const tf of taskFiles) {
            try {
              const task = JSON.parse(fs.readFileSync(path.join(tasksDir, tf), 'utf-8'));
              taskList.push({ id: task.id, subject: task.subject, status: task.status, owner: task.owner, activeForm: task.activeForm });
            } catch {}
          }
        } catch {}
      }

      const existing = teams.get(teamName);
      const memberIds = config.members.map(m => m.agentId).sort().join(',');
      const taskHash = taskList.map(t => `${t.id}:${t.status}:${t.owner}`).join(',');

      if (existing) {
        // Check for member changes
        const existMemberIds = existing.members.map(m => m.agentId).sort().join(',');
        if (existMemberIds !== memberIds) {
          existing.members = config.members;
          existing.tasks = taskList;
          agentTeamMap.set(leadAgentId, teamName);
          send({ type: 'teamDetected', team: { name: teamName, leadAgentId, members: config.members, tasks: taskList } });
        }
        // Check for task changes
        const existTaskHash = existing.tasks.map(t => `${t.id}:${t.status}:${t.owner}`).join(',');
        if (existTaskHash !== taskHash) {
          existing.tasks = taskList;
          send({ type: 'teamTasksUpdated', teamName, tasks: taskList });
        }
      } else {
        // New team found
        const teamData = { name: teamName, leadAgentId, leadSessionId: config.leadSessionId, members: config.members, tasks: taskList };
        teams.set(teamName, teamData);
        agentTeamMap.set(leadAgentId, teamName);
        send({ type: 'teamDetected', team: { name: teamName, leadAgentId, members: config.members, tasks: taskList } });
        console.log(`[Overlord] Team detected: ${teamName} (lead agent ${leadAgentId}, ${config.members.length} members)`);
      }
    }

    // Clean up teams whose lead agent was closed
    for (const [teamName, teamData] of teams) {
      if (!agents.has(teamData.leadAgentId)) {
        teams.delete(teamName);
        agentTeamMap.delete(teamData.leadAgentId);
        send({ type: 'teamRemoved', teamName });
      }
    }
  } catch (e) { console.log('[Overlord] Team scan error:', e.message); }
}

// ── @Mention detection + context injection ─────────────
const inputBuffers = new Map(); // agentId -> string buffer
const pendingTermInput = new Map(); // agentId -> array of strings queued pre-spawn
const inBracketedPaste = new Set(); // agentIds currently inside a bracketed paste
const bracketedPasteBuffers = new Map(); // agentId -> accumulated paste content
const LONG_PASTE_THRESHOLD = 500; // chars above which paste is saved to a temp file

function findMentions(text) {
  const re = /@([A-Za-z][A-Za-z0-9]*)/g;
  const found = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    for (const [id, a] of agents) {
      if (a.agentName && a.agentName.toLowerCase() === name.toLowerCase() && !seen.has(id)) {
        seen.add(id);
        found.push({ id, agent: a, raw: m[0] });
        break;
      }
    }
  }
  return found;
}

function buildMentionContext(mentions) {
  const blocks = [];
  for (const { agent: a } of mentions) {
    const status = a.isWaiting ? 'idle' : (a.toolIds.size > 0 ? 'active' : 'idle');
    const toolList = [...a.toolStatuses.values()].join(', ') || 'none';
    const turns = a.stats?.turns || 0;
    const tokIn = a.stats?.inTok || 0;
    const tokOut = a.stats?.outTok || 0;
    const lines = [
      `[Context for @${a.agentName}]`,
      `- Status: ${status}`,
    ];
    if (a.title) lines.push(`- Task: ${a.title}`);
    if (a.lastPrompt) lines.push(`- Last prompt: ${a.lastPrompt}`);
    if (a.lastText) lines.push(`- Last response: ${a.lastText}`);
    lines.push(`- Current tools: ${toolList}`);
    lines.push(`- Project: ${a.cwd}`);
    lines.push(`- Session: ${a.sessionId}`);
    lines.push(`- Transcript file: ${a.jsonlFile}`);
    lines.push(`- Turns: ${turns}, Tokens: ${tokIn + tokOut} (${tokIn} in + ${tokOut} out)`);
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

function writePtyChunked(proc, data, chunkSize = 1024) {
  if (data.length <= chunkSize) { proc.write(data); return; }
  let offset = 0;
  (function next() {
    if (offset >= data.length) return;
    proc.write(data.slice(offset, offset + chunkSize));
    offset += chunkSize;
    if (offset < data.length) setTimeout(next, 8);
  })();
}

function savePasteToFile(content) {
  const file = path.join(os.tmpdir(), `overlord-paste-${Date.now()}.txt`);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function handleTermInput(id, data) {
  const t = terminals.get(id);
  if (!t) {
    // PTY not yet spawned — queue input, flushed after spawn.
    const q = pendingTermInput.get(id) || [];
    q.push(data);
    // cap queue to prevent unbounded growth if spawn never happens
    if (q.length > 1024) q.shift();
    pendingTermInput.set(id, q);
    return;
  }
  let buf = inputBuffers.get(id) || '';

  // Bracketed paste — accumulate full content to check length before sending.
  if (data.includes('\x1b[200~')) {
    const openIdx = data.indexOf('\x1b[200~') + 6;
    const closeIdx = data.indexOf('\x1b[201~');
    if (closeIdx !== -1) {
      // Complete paste in single chunk
      const content = data.slice(openIdx, closeIdx);
      if (content.length > LONG_PASTE_THRESHOLD) {
        const filePath = savePasteToFile(content);
        t.write(filePath);
      } else {
        writePtyChunked(t, data);
      }
    } else {
      // Multi-chunk paste — start accumulating, don't write yet
      inBracketedPaste.add(id);
      bracketedPasteBuffers.set(id, data.slice(openIdx));
    }
    inputBuffers.set(id, '');
    return;
  }
  if (inBracketedPaste.has(id)) {
    const closeIdx = data.indexOf('\x1b[201~');
    if (closeIdx !== -1) {
      const content = (bracketedPasteBuffers.get(id) || '') + data.slice(0, closeIdx);
      inBracketedPaste.delete(id);
      bracketedPasteBuffers.delete(id);
      if (content.length > LONG_PASTE_THRESHOLD) {
        const filePath = savePasteToFile(content);
        t.write(filePath);
      } else {
        writePtyChunked(t, '\x1b[200~' + content + '\x1b[201~');
      }
    } else {
      bracketedPasteBuffers.set(id, (bracketedPasteBuffers.get(id) || '') + data);
      if (data.length === 1) { // safety: single char means paste mode ended unexpectedly
        inBracketedPaste.delete(id);
        bracketedPasteBuffers.delete(id);
        t.write(data);
      }
    }
    return;
  }

  // Multi-char paste or chunk containing Enter — pass straight through.
  // Mention scanning only happens on interactive single-char Enter to avoid
  // mangling pasted text that contains @ symbols (emails, decorators, etc.).
  if (data.length > 1 && data.includes('\r')) {
    const full = buf + data;
    const lastCR = full.lastIndexOf('\r');
    const remainder = full.slice(lastCR + 1);
    markSessionSwitch(id, full.slice(0, lastCR));
    const renameMatch = full.slice(0, lastCR).match(/^\s*\/rename\s+(.+?)\s*$/);
    if (renameMatch) { const a = agents.get(id); if (a) { a.title = renameMatch[1]; a.customName = true; send({ type: 'title', id, text: a.title, customName: true }); saveState(); } }
    if (data.length > LONG_PASTE_THRESHOLD) {
      const filePath = savePasteToFile(data);
      t.write(filePath);
    } else {
      writePtyChunked(t, data);
    }
    inputBuffers.set(id, remainder);
    return;
  }

  // Single-char handling
  if (data === '\r') {
    // Detect /clear or /resume — both move the agent to a different JSONL file
    markSessionSwitch(id, buf);
    const renameM = buf.match(/^\s*\/rename\s+(.+?)\s*$/);
    if (renameM) { const a = agents.get(id); if (a) { a.title = renameM[1]; a.customName = true; send({ type: 'title', id, text: a.title, customName: true }); saveState(); } }
    // Enter pressed — remote mentions (@Agent@peer) first: send over the peer
    // socket, then strip them so the local scanner doesn't also fire on the
    // '@Agent' prefix. Local text still submits to this agent as usual.
    const remote = pc.parseRemoteMentions(buf, connectedPeerNames());
    if (remote.length > 0) sendRemoteMentionMessages(id, buf, remote);
    const mentions = findMentions(remote.length > 0 ? pc.stripRemoteMentions(buf, connectedPeerNames()) : buf);
    if (mentions.length > 0) {
      const ctx = buildMentionContext(mentions);
      t.write('\x15'); // Ctrl+U to clear readline
      t.write(buf + '\n\n' + ctx + '\r');
    } else {
      t.write('\r');
    }
    inputBuffers.set(id, '');
    return;
  }

  if (data === '\x7f' || data === '\b') {
    // Backspace — trim buffer
    buf = buf.slice(0, -1);
    inputBuffers.set(id, buf);
    t.write(data);
    return;
  }

  if (data === '\x03' || data === '\x15') {
    // Ctrl+C or Ctrl+U — clear buffer
    inputBuffers.set(id, '');
    t.write(data);
    return;
  }

  if (data.startsWith('\x1b')) {
    // Escape sequence (arrows, etc) — pass through, don't buffer
    t.write(data);
    return;
  }

  // Printable char — buffer + pass through
  buf += data;
  inputBuffers.set(id, buf);
  t.write(data);
}

// ── Window activity tracking (gates usage polling) ─────
let _windowFocused = true;
let _lastActivity = Date.now();
const IDLE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes of no IPC = idle
function isUserActive() { return _windowFocused && (Date.now() - _lastActivity < IDLE_THRESHOLD_MS); }

// ── IPC ────────────────────────────────────────────────
// ── Worktrees & per-worktree dev servers ──────────────
function projectConfig(repo) { return (settings.projects || {})[repo] || null; }

// Fill a URL template's port token. Supports {port} and arithmetic {port+1}/{port-1} so
// repos whose openable app runs at base+N (e.g. back-office's vite client at base+1, with
// the API on base) can point the link at the right port.
function fillPort(template, base) {
  return String(template || 'http://localhost:{port}')
    .replace(/\{port([+-]\d+)?\}/g, (_, off) => String(Number(base) + (off ? parseInt(off, 10) : 0)));
}

// Ensure the project has a runnable config, filling any missing fields from detection.
// Merges (doesn't overwrite) so an existing partial config — e.g. just {defaultBase} that
// createFeature wrote — still gets a devCommand/urlTemplate so the server can start.
function ensureProjectConfig(repo, base) {
  const g = wt.detectDevCommand(repo);
  const cur = projectConfig(repo) || {};
  settings.projects = settings.projects || {};
  const cfg = settings.projects[repo] = {
    devCommand: cur.devCommand || g.devCommand,
    urlTemplate: cur.urlTemplate || g.urlTemplate,
    basePort: cur.basePort || 5170,
    portStep: cur.portStep || 10,
    seedFiles: cur.seedFiles || g.seedFiles,
    defaultBase: base || cur.defaultBase || 'dev',
  };
  return cfg;
}
function findWorktree(p) { return (settings.worktrees || []).find(w => w.path === p) || null; }

// Sticky base port per worktree, allocated GLOBALLY across all repos so two worktrees
// (even in different repos of the same feature) never share a port. portStep (default 10)
// leaves room for a repo's secondary ports (BFF, client) as PORT+1, PORT+2.
function nextBasePort(repo) {
  const cfg = projectConfig(repo) || {};
  const base = Number(cfg.basePort) || 5170;
  const step = Number(cfg.portStep) || 10;
  const used = new Set((settings.worktrees || []).filter(w => w.port).map(w => w.port));
  let port = base;
  while (used.has(port)) port += step;
  return port;
}

async function doCreateWorktree({ repo, branch, base, feature }) {
  branch = wt.safeBranch(branch); // git forbids spaces/special chars in branch names
  const dest = await wt.createWorktree({ repo, branch, base });
  ensureProjectConfig(repo, base);
  const cfg = projectConfig(repo);
  const seeds = (cfg && cfg.seedFiles) ? cfg.seedFiles : wt.detectSeedFiles(repo);
  wt.copySeedFiles(repo, dest, seeds);
  const entry = { path: dest, repo, branch, base, port: nextBasePort(repo), status: 'setup', feature: feature || null, autostart: true };
  settings.worktrees = settings.worktrees || [];
  settings.worktrees.push(entry);
  saveState();
  send({ type: 'settings', settings });
  send({ type: 'toast', text: `Created worktree ${branch}` });
  installWorktree(entry);
  return entry;
}

// Install deps so the worktree is actually runnable. Runs in the background; the group
// card shows a "setup" state until done. seamless > watching npm scroll.
function installWorktree(entry) {
  const pm = wt.detectPackageManager(entry.path);
  if (!pm) { entry.status = 'ready'; saveState(); send({ type: 'settings', settings }); return; }
  const logPath = path.join(STATE_DIR, 'logs', `setup-${wt.slug(entry.branch)}.log`);
  entry.setupLog = logPath;
  try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); fs.writeFileSync(logPath, `# ${pm} install in ${entry.path}\n# started ${new Date().toISOString()}\n\n`); } catch {}
  const append = d => { try { fs.appendFileSync(logPath, d); } catch {} };
  send({ type: 'toast', text: `Setting up ${entry.branch} — installing dependencies…` });

  // Attempt install; on failure retry once with --legacy-peer-deps (repos like frontline
  // have peer conflicts that need it) — which also covers a transient npm crash.
  const attempt = (extraArgs, isRetry) => {
    append(`\n# ${pm} install ${extraArgs.join(' ')} ${isRetry ? '(retry)' : ''}\n`);
    const args = pm === 'npm' ? ['install', '--no-audit', '--no-fund', ...extraArgs] : ['install', ...extraArgs];
    const proc = spawn(pm, args, { cwd: entry.path, windowsHide: true, shell: process.platform === 'win32' });
    proc.stdout && proc.stdout.on('data', append);
    proc.stderr && proc.stderr.on('data', append);
    proc.on('exit', (code) => {
      append(`\n# exit code ${code}\n`);
      if (code === 0) {
        entry.status = 'ready'; saveState(); send({ type: 'settings', settings });
        // Auto-start the dev server once deps are in, so a new feature/worktree comes up
        // ready to open in the browser without a second click.
        if (entry.autostart && projectConfig(entry.repo) && projectConfig(entry.repo).devCommand) {
          const url = fillPort(projectConfig(entry.repo).urlTemplate, entry.port);
          send({ type: 'toast', text: `${entry.branch} ready — starting server at ${url}` });
          startDevServer(entry.path);
        } else {
          send({ type: 'toast', text: `${entry.branch} ready` });
        }
      } else if (!isRetry) {
        flog(`Setup for ${entry.branch}: ${pm} install exited ${code}, retrying with --legacy-peer-deps`);
        attempt(pm === 'npm' ? ['--legacy-peer-deps'] : [], true);
      } else {
        entry.status = 'failed'; saveState(); send({ type: 'settings', settings });
        flog(`Setup failed for ${entry.branch}: install exited ${code}. Log: ${logPath}`);
        send({ type: 'toast', text: `${entry.branch} setup failed (exit ${code}) — see log in ⋮ menu` });
      }
    });
    proc.on('error', (e) => {
      append(`\n# spawn error: ${e.stack || e.message}\n`);
      if (!isRetry) { attempt(pm === 'npm' ? ['--legacy-peer-deps'] : [], true); return; }
      entry.status = 'failed'; saveState(); send({ type: 'settings', settings });
      flog(`Setup spawn error for ${entry.branch}: ${e.message}. Log: ${logPath}`);
      send({ type: 'toast', text: `${entry.branch} setup failed: ${e.message}` });
    });
  };
  attempt([], false);
}

function startDevServer(p) {
  const entry = findWorktree(p);
  if (!entry) return;
  let cfg = projectConfig(entry.repo);
  if (!cfg || !cfg.devCommand) { cfg = ensureProjectConfig(entry.repo, entry.base); saveState(); send({ type: 'settings', settings }); }
  if (!cfg.devCommand) { send({ type: 'toast', text: 'No dev command detected — set one in Configure dev server' }); return; }
  // Upgrade a stale generic URL template to the detected one (e.g. back-office's openable app
  // is the vite client at base+1, not the API on base). Only touches the plain default, so a
  // custom template the user set is preserved.
  if (!cfg.urlTemplate || cfg.urlTemplate === 'http://localhost:{port}') {
    const g = wt.detectDevCommand(entry.repo);
    if (g.urlTemplate && g.urlTemplate !== cfg.urlTemplate) { cfg.urlTemplate = g.urlTemplate; saveState(); send({ type: 'settings', settings }); }
  }
  if (devServers.has(p)) return;
  const url = fillPort(cfg.urlTemplate, entry.port);
  const logPath = path.join(STATE_DIR, 'logs', `server-${wt.slug(entry.branch)}-${wt.slug(path.basename(entry.repo))}.log`);
  entry.serverLog = logPath;
  try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); fs.writeFileSync(logPath, `# ${cfg.devCommand}\n# cwd ${entry.path}  PORT=${entry.port}\n# started ${new Date().toISOString()}\n\n`); } catch {}
  const append = d => { try { fs.appendFileSync(logPath, d); } catch {} };
  const shell2 = process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL || 'bash');
  const shellArgs = process.platform === 'win32' ? ['/c', cfg.devCommand] : ['-c', cfg.devCommand];
  const env = { ...process.env, PORT: String(entry.port), PORT_BASE: String(entry.port) };
  try {
    const proc = pty.spawn(shell2, shellArgs, { name: 'xterm-256color', cols: 120, rows: 30, cwd: entry.path, env });
    const startedAt = Date.now();
    let tail = '';
    proc.onData(d => { append(d); tail = (tail + d).slice(-1500); });
    proc.onExit((e) => {
      append(`\n# exited (code ${e && e.exitCode}) after ${Math.round((Date.now() - startedAt) / 1000)}s\n`);
      devServers.delete(p);
      send({ type: 'wtServer', path: p, running: false });
      // A server that dies within a few seconds never really started — surface why + point at the log.
      if (Date.now() - startedAt < 5000) {
        const line = tail.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim().split('\n').filter(Boolean).pop();
        flog(`Dev server for ${entry.branch}/${path.basename(entry.repo)} exited early. Log: ${logPath}`);
        send({ type: 'toast', text: `${path.basename(entry.repo)} server stopped: ${line || 'exited immediately'} — see server log in ⋮` });
      }
    });
    devServers.set(p, { proc, port: entry.port, url, repo: entry.repo });
    send({ type: 'wtServer', path: p, running: true, port: entry.port, url });
    send({ type: 'toast', text: `Starting server: ${url}` });
  } catch (e) {
    append(`\n# spawn error: ${e.message}\n`);
    send({ type: 'toast', text: 'Failed to start server: ' + e.message });
  }
}

function stopDevServer(p) {
  const s = devServers.get(p);
  if (s) { try { s.proc.kill(); } catch {} killPortProcess(s.port); devServers.delete(p); }
  send({ type: 'wtServer', path: p, running: false });
}

// If cwd is a worktree in a feature, give the agent tool-access to its sibling repos
// (--add-dir) and a system-prompt note about them, plus env vars. Returns claude flags + env.
function featureAgentArgs(cwd) {
  const self = findWorktree(cwd);
  if (!self || !self.feature) return { flags: '', env: {} };
  const siblings = (settings.worktrees || []).filter(w => w.feature === self.feature && w.path !== cwd && fs.existsSync(w.path));
  const env = {
    OVERLORD_FEATURE: self.feature,
    OVERLORD_FEATURE_BRANCH: self.branch || '',
    OVERLORD_FEATURE_REPOS: siblings.map(w => `${path.basename(w.repo)}=${w.path}`).join(';'),
  };
  if (!siblings.length) return { flags: '', env };
  const list = siblings.map(w => `${path.basename(w.repo)} (${w.path})`).join('; ');
  const note = (`This git worktree is part of feature "${self.feature}" on branch ${self.branch}, spanning multiple repos. `
    + `Sibling repos in the same feature (same branch) are: ${list}. They are already in your allowed directories — `
    + `read and edit files in them when the task spans repos.`)
    .replace(/"/g, "'").replace(/[\r\n]+/g, ' ').replace(/%/g, 'pct');
  const addDirs = siblings.map(w => `--add-dir "${w.path}"`).join(' ');
  return { flags: ` ${addDirs} --append-system-prompt "${note}"`, env };
}

function handleIpc(msg) {
  switch (msg.type) {
    case 'createAgent': createAgent(msg.cwd, msg.prompt); break;
    case 'listBranches': {
      wt.listBranches(msg.repo)
        .then(branches => send({ type: 'branchList', repo: msg.repo, branches, error: null }))
        .catch(e => send({ type: 'branchList', repo: msg.repo, branches: null, error: e.message }));
      break;
    }
    case 'detectProject': {
      const guess = wt.detectDevCommand(msg.repo);
      send({ type: 'projectDetected', repo: msg.repo, guess, existing: projectConfig(msg.repo) });
      break;
    }
    case 'saveProjects': {
      settings.knownProjects = Array.isArray(msg.dirs) ? [...new Set(msg.dirs.filter(d => typeof d === 'string'))] : [];
      saveState();
      break;
    }
    case 'saveProjectConfig': {
      const c = msg.config || {};
      settings.projects = settings.projects || {};
      settings.projects[msg.repo] = {
        devCommand: String(c.devCommand || ''),
        urlTemplate: String(c.urlTemplate || 'http://localhost:{port}'),
        basePort: Math.max(1024, Number(c.basePort) || 5170),
        portStep: Math.max(1, Number(c.portStep) || 10),
        seedFiles: Array.isArray(c.seedFiles) ? c.seedFiles.map(String) : ['.env', '.env.local', '.certs'],
      };
      saveState();
      send({ type: 'settings', settings });
      break;
    }
    case 'createWorktree': {
      doCreateWorktree({ repo: msg.repo, branch: msg.branch, base: msg.base || 'dev', feature: msg.feature || null })
        .catch(e => { flog('createWorktree failed:', e); send({ type: 'toast', text: 'Worktree failed: ' + (e.message || 'error') }); });
      break;
    }
    case 'createFeature': {
      const name = String(msg.name || '').trim();
      const repos = Array.isArray(msg.repos) ? msg.repos : [];
      if (!name || !repos.length) break;
      // Remember choices for next time: each repo's base + the set of repos used.
      settings.projects = settings.projects || {};
      for (const r of repos) {
        settings.projects[r.repo] = { ...(settings.projects[r.repo] || {}), defaultBase: r.base || 'dev' };
      }
      settings.lastFeatureRepos = repos.map(r => r.repo);
      saveState();
      send({ type: 'settings', settings });
      for (const r of repos) {
        doCreateWorktree({ repo: r.repo, branch: name, base: r.base || 'dev', feature: name })
          .catch(e => { flog(`createFeature ${name} / ${r.repo} failed:`, e); send({ type: 'toast', text: `Feature ${name} — ${path.basename(r.repo)} failed: ${e.message || 'error'}` }); });
      }
      break;
    }
    case 'removeWorktree': {
      const entry = findWorktree(msg.path);
      if (!entry) break;
      stopDevServer(msg.path);
      for (const [id, a] of agents) { if (a.cwd === msg.path) closeAgent(id); }
      // Optimistic: drop from state + UI now so it feels instant; deleting node_modules
      // (thousands of files) is slow, so run the actual git worktree removal in the background.
      settings.worktrees = (settings.worktrees || []).filter(w => w.path !== msg.path);
      saveState();
      send({ type: 'settings', settings });
      wt.removeWorktree({ repo: entry.repo, dest: entry.path, branch: entry.branch, deleteBranch: !!msg.deleteBranch })
        .catch(e => { flog('removeWorktree cleanup failed:', e); send({ type: 'toast', text: `Cleanup of ${entry.branch} folder failed — remove it manually` }); });
      break;
    }
    case 'openSetupLog': {
      const entry = findWorktree(msg.path);
      const p = entry && entry.setupLog;
      if (p && fs.existsSync(p)) shell.openPath(p).catch(() => {});
      else send({ type: 'toast', text: 'No setup log yet' });
      break;
    }
    case 'retrySetup': {
      const entry = findWorktree(msg.path);
      if (entry) { entry.status = 'setup'; saveState(); send({ type: 'settings', settings }); installWorktree(entry); }
      break;
    }
    case 'openServerLog': {
      const entry = findWorktree(msg.path);
      const lp = entry && entry.serverLog;
      if (lp && fs.existsSync(lp)) shell.openPath(lp).catch(() => {});
      else send({ type: 'toast', text: 'No server log yet — start the server first' });
      break;
    }
    case 'startDevServer': startDevServer(msg.path); break;
    case 'stopDevServer': stopDevServer(msg.path); break;
    case 'restartDevServer':
      stopDevServer(msg.path);
      // Give the OS a moment to release the port before the command rebinds it —
      // strictPort dev servers (vite) fail hard if it's still held.
      setTimeout(() => startDevServer(msg.path), 600);
      break;
    case 'createPr': {
      const entry = findWorktree(msg.path);
      if (!entry) break;
      send({ type: 'toast', text: `Creating PR for ${entry.branch}…` });
      execFile('gh', ['pr', 'create', '--base', entry.base, '--head', entry.branch, '--fill'],
        { cwd: entry.path, timeout: 60000, windowsHide: true, shell: process.platform === 'win32' },
        (err, stdout, stderr) => {
          if (err) { send({ type: 'toast', text: 'PR failed: ' + ghErr({ message: (stderr || err.message || '').split('\n').find(Boolean) || 'error' }) }); return; }
          const url = String(stdout || '').trim().split('\n').filter(Boolean).pop() || '';
          send({ type: 'toast', text: 'PR created: ' + url });
          if (/^https?:\/\//.test(url)) shell.openExternal(url).catch(() => {});
          try { pollPRs(); } catch {}
        });
      break;
    }
    case 'closeAgent': closeAgent(msg.id); break;
    case 'archiveAgent': archiveAgent(msg.id); break;
    case 'unarchiveAgent': unarchiveAgent(msg.id); break;
    case 'renameAgent': { const a = agents.get(msg.id); const t = terminals.get(msg.id); if (a) { a.title = msg.name; a.customName = true; send({ type: 'title', id: msg.id, text: msg.name, customName: true }); saveState(); if (t) t.write(`/rename ${msg.name}\r`); } break; }
    case 'clearCustomName': { const a = agents.get(msg.id); if (a) { a.customName = false; send({ type: 'title', id: msg.id, text: a.title, customName: false }); saveState(); generateSummaryTitle(msg.id); } break; }
    // Resume the SAME session after a crash — spawnTerminal re-attaches with
    // `claude --resume <sessionId>`, keeping the conversation. restartAgent (below)
    // throws the chat away and creates a fresh agent, so it can't serve this.
    case 'resumeAgent': {
      const a = agents.get(msg.id);
      if (a && !terminals.has(msg.id)) {
        a.crashCount = 0; a.crashed = false; a._resumeFailed = false;
        send({ type: 'crashCleared', id: msg.id });
        spawnTerminal(msg.id);
      }
      break;
    }
    case 'restartAgent': {
      const a = agents.get(msg.id);
      if (a) {
        const c = a.cwd;
        const savedTitle = a.title || '';
        const savedCustomName = a.customName;
        const savedAgentName = a.agentName;
        closeAgent(msg.id);
        const newId = createAgent(c);
        const na = agents.get(newId);
        if (na && savedAgentName) { na.agentName = savedAgentName; send({ type: 'agentNameChanged', id: newId, agentName: savedAgentName }); }
        if (savedTitle && na) {
          na.title = savedTitle;
          na.customName = savedCustomName;
          send({ type: 'title', id: newId, text: savedTitle, customName: savedCustomName });
          saveState();
        }
        send({ type: 'focusFromNotification', id: newId });
      }
      break;
    }
    case 'focusAgent': spawnTerminal(msg.id); send({ type: 'focused', id: msg.id }); break;
    case 'termInput': handleTermInput(msg.id, msg.data); break;
    case 'ghostComplete': ghostComplete(msg.id, msg.reqId, msg.prefix, msg.context); break;
    case 'stopLoop': { const a = agents.get(msg.id); if (a) { a.cronCount = 0; send({ type: 'looping', id: msg.id, active: false, count: 0 }); } const t = terminals.get(msg.id); if (t) t.write('\x03'); break; }
    case 'compactAgent': { const a = agents.get(msg.id); const t = terminals.get(msg.id); if (a && t && a.isWaiting) { a.compacting = true; send({ type: 'compacting', id: msg.id, active: true }); t.write('/compact\r'); } break; }
    case 'termResize': { const t = terminals.get(msg.id); if (t) try { t.resize(msg.cols, msg.rows); } catch {} break; }
    case 'browseFolder':
      dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: 'Select Project Folder' })
        .then(r => { if (!r.canceled && r.filePaths[0]) send({ type: 'folderSelected', path: r.filePaths[0] }); });
      break;
    case 'browseFeatureRepo':
      dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: 'Select a git repo for this feature' })
        .then(async r => {
          if (r.canceled || !r.filePaths[0]) return;
          const dir = r.filePaths[0];
          let root = null;
          try { root = await wt.repoRoot(dir); } catch {}
          if (!root) { send({ type: 'toast', text: 'Not a git repository: ' + dir }); return; }
          send({ type: 'featureRepoAdded', repo: root });
        });
      break;
    case 'openUrl': { const url = msg.url; if (typeof url === 'string' && /^(?:https?|file):\/\//.test(url)) shell.openExternal(url).catch(() => {}); break; }
    case 'savePrSettings': {
      const p = msg.prSettings || {};
      settings.prSettings = {
        enabled: !!p.enabled,
        repos: Array.isArray(p.repos) ? p.repos.filter(r => PR_REPO_RE.test(r)) : [],
        intervalSec: Math.max(30, Number(p.intervalSec) || 60),
      };
      prSeenSeeded = false; // re-seed silently against the new repo set
      settings.prSeen = [];
      saveState();
      send({ type: 'settings', settings });
      armPrTimer();
      break;
    }
    case 'listRepos': {
      execFile('gh', ['api', '--paginate', 'user/repos?per_page=100', '--jq', '.[].full_name'],
        { timeout: 30000, windowsHide: true, shell: process.platform === 'win32', maxBuffer: 16 * 1024 * 1024 },
        (err, stdout) => {
          if (err) { send({ type: 'repoList', repos: null, error: ghErr(err), errorCode: ghErrCode(err) }); return; }
          const repos = [...new Set(stdout.split('\n').map(s => s.trim()).filter(Boolean))].sort();
          send({ type: 'repoList', repos, error: null });
        });
      break;
    }
    case 'saveActionsSettings': {
      const a = msg.actionsSettings || {};
      settings.actionsSettings = {
        enabled: !!a.enabled,
        workflows: sanitizeWorkflows(a.workflows),
        intervalSec: Math.max(30, Number(a.intervalSec) || 60),
      };
      saveState();
      send({ type: 'settings', settings });
      armActionsTimer();
      break;
    }
    case 'listWorkflows': {
      const repo = String(msg.repo || '').trim();
      if (!WF_REPO_RE.test(repo)) { send({ type: 'workflowList', repo, workflows: null, error: 'Invalid repo' }); break; }
      ghJson(['api', '--paginate', `/repos/${repo}/actions/workflows?per_page=100`], 30000).then((res) => {
        if (res.error) { send({ type: 'workflowList', repo, workflows: null, error: res.error, errorCode: res.errorCode || null }); return; }
        const workflows = ((res.data && res.data.workflows) || [])
          .filter(w => w && typeof w.path === 'string')
          .map(w => ({ file: w.path.split('/').pop(), name: w.name || '', state: w.state || '' }))
          .filter(w => WF_FILE_RE.test(w.file));
        send({ type: 'workflowList', repo, workflows, error: null });
      });
      break;
    }
    case 'pollActionsNow': armActionsTimer(); break;
    case 'killServer': {
      const port = msg.port;
      if (typeof port !== 'number' || port < 1024 || port > 65535) break;
      killPortProcess(port);
      // Remove from all agents' server maps and notify renderer
      for (const [id, ports] of serverPorts) {
        if (ports.has(port)) {
          ports.delete(port);
          if (ports.size === 0) serverPorts.delete(id);
          send({ type: 'serverRemoved', id, port });
        }
      }
      break;
    }
    case 'restartServer': {
      const port = msg.port;
      if (typeof port !== 'number' || port < 1024 || port > 65535) break;
      killPortProcess(port);
      // Keep the badge — the dev server watcher should auto-restart it
      break;
    }
    case 'openFolder': { const p = msg.path; if (typeof p === 'string' && fs.existsSync(p)) shell.openPath(p).catch(() => {}); break; }
    case 'openBookmark': {
      const p = msg.path;
      if (typeof p !== 'string' || !fs.existsSync(p)) { send({ type: 'toast', text: 'Bookmark not found: ' + p }); break; }
      shell.openPath(p).catch(() => {});
      break;
    }
    case 'addBookmark':
      // Windows/Linux can't show a combined file+directory picker, so the caller picks a mode.
      dialog.showOpenDialog(mainWindow, msg.dir
        ? { properties: ['openDirectory'], title: 'Bookmark a folder' }
        : { properties: ['openFile'], title: 'Bookmark a file', filters: [{ name: 'All Files', extensions: ['*'] }] })
        .then(r => {
          if (r.canceled || !r.filePaths[0]) return;
          const p = r.filePaths[0];
          settings.bookmarks = settings.bookmarks || [];
          if (settings.bookmarks.some(b => b.path === p)) return;
          settings.bookmarks.push({ path: p, name: path.basename(p) || p });
          saveState();
          send({ type: 'settings', settings });
        });
      break;
    case 'removeBookmark':
      settings.bookmarks = (settings.bookmarks || []).filter(b => b.path !== msg.path);
      saveState();
      send({ type: 'settings', settings });
      break;
    case 'renameBookmark': {
      const b = (settings.bookmarks || []).find(x => x.path === msg.path);
      const name = typeof msg.name === 'string' ? msg.name.trim() : '';
      if (!b || !name) break;
      b.name = name;
      saveState();
      send({ type: 'settings', settings });
      break;
    }
    case 'openFile': {
      let p = typeof msg.path === 'string' ? msg.path : '';
      if (!p) break;
      // Parse optional :line:col suffix
      const lc = p.match(/^(.+?):(\d+)(?::(\d+))?$/);
      let line, col;
      if (lc) { p = lc[1]; line = lc[2]; col = lc[3]; }
      // Resolve relative paths against the agent's cwd
      if (!path.isAbsolute(p)) {
        const a = agents.get(msg.id);
        if (a) p = path.resolve(a.cwd, p);
      }
      if (!fs.existsSync(p)) break;
      shell.openPath(p).catch(() => {});
      break;
    }
    case 'pasteImage': {
      const img = clipboard.readImage();
      if (img.isEmpty()) {
        // No bitmap on clipboard — likely a file reference (e.g. image file copied from Explorer).
        // Fall through to file-path paste logic.
        msg.type = 'pasteFiles';
        handleIpc(msg);
        break;
      }
      const dir = path.join(os.tmpdir(), 'overlord-clipboard');
      fs.mkdirSync(dir, { recursive: true });
      const filename = `paste-${Date.now()}.png`;
      const filePath = path.join(dir, filename);
      fs.writeFileSync(filePath, img.toPNG());
      const insertPath = filePath.replace(/\\/g, '/');
      // Create thumbnail for inline terminal preview (max 400px wide)
      const sz = img.getSize();
      const thumb = sz.width > 400 ? img.resize({ width: 400 }) : img;
      const base64 = thumb.toPNG().toString('base64');
      handleTermInput(msg.id, insertPath + ' ');
      send({ type: 'imagePasted', id: msg.id, path: insertPath, base64 });
      break;
    }
    case 'pasteFiles': {
      let filePaths = [];
      if (process.platform === 'win32') {
        // Try CF_HDROP first (Explorer's primary format for file copy)
        try {
          const buf = clipboard.readBuffer('CF_HDROP');
          if (buf && buf.length > 20) {
            const pFiles = buf.readUInt32LE(0);
            const fWide = buf.readUInt32LE(16);
            const raw = fWide
              ? buf.slice(pFiles).toString('utf16le')
              : buf.slice(pFiles).toString('ascii');
            filePaths = raw.split('\0').filter(p => p.length > 0);
          }
        } catch (_) {}
        // Fallback: FileNameW (single-file format, some apps use this)
        if (filePaths.length === 0) {
          try {
            const buf = clipboard.readBuffer('FileNameW');
            if (buf && buf.length > 0) {
              const raw = buf.toString('utf16le');
              filePaths = raw.split('\0').filter(p => p.length > 0);
            }
          } catch (_) {}
        }
      } else {
        // macOS/Linux: clipboard may contain file URIs
        const text = clipboard.readText();
        if (text) {
          filePaths = text.split('\n')
            .map(l => l.trim())
            .filter(l => l.startsWith('file://'))
            .map(l => decodeURIComponent(l.replace('file://', '')));
        }
      }
      // Keep only paths that exist on disk (files or directories)
      filePaths = filePaths.filter(p => {
        try { fs.statSync(p); return true; } catch (_) { return false; }
      });
      if (filePaths.length === 0) break;
      const text = filePaths
        .map(p => p.replace(/\\/g, '/'))
        .map(p => p.includes(' ') ? `"${p}"` : p)
        .join(' ');
      handleTermInput(msg.id, text);
      break;
    }
    case 'dropPaths': {
      const folders = [], filePaths = [];
      for (const p of (msg.paths || [])) {
        try { if (fs.statSync(p).isDirectory()) { folders.push(p); continue; } } catch {}
        filePaths.push(p);
      }
      for (const f of folders) createAgent(f);
      if (filePaths.length > 0 && msg.activeAgent && terminals.has(msg.activeAgent)) {
        const text = filePaths.map(p => p.includes(' ') ? `"${p}"` : p).join(' ');
        handleTermInput(msg.activeAgent, text);
      }
      break;
    }
    case 'exportTranscript': exportTranscript(msg.id).catch(e => console.log('[Overlord] Export failed:', e.message)); break;
    case 'saveSettings': Object.assign(settings, msg.settings); saveState(); break;
    case 'peersEnable': {
      settings.peersEnabled = !!msg.enabled;
      saveState();
      if (settings.peersEnabled) startPeerClients(); else stopAllPeers();
      sendPeersState();
      break;
    }
    case 'setPeerName': {
      const n = pc.sanitizePeerName(msg.name);
      if (n) { settings.peerName = n; saveState(); }
      sendPeersState();
      break;
    }
    case 'addPeer': {
      const r = pc.normalizePeer({ host: msg.host, port: msg.port, code: msg.code });
      if (!r.ok) { send({ type: 'toast', text: '✕ ' + r.error }); break; }
      settings.peers = Array.isArray(settings.peers) ? settings.peers : [];
      const dup = settings.peers.find(p => p.host === r.peer.host && p.port === r.peer.port);
      if (dup) dup.code = r.peer.code; else settings.peers.push(r.peer);
      saveState();
      if (settings.peersEnabled) dialPeer(r.peer);
      sendPeersState();
      break;
    }
    case 'removePeer': {
      settings.peers = (settings.peers || []).filter(p => !(p.host === msg.host && p.port === msg.port));
      saveState();
      for (const c of [...peerConns]) if (c.cfg && c.cfg.host === msg.host && c.cfg.port === msg.port) closePeerConn(c);
      const d = peerDialers.get(msg.host + ':' + msg.port);
      if (d) { clearTimeout(d.timer); peerDialers.delete(msg.host + ':' + msg.port); }
      sendPeersState();
      break;
    }
    case 'peerSend': {
      const conn = findPeerConn(msg.peerName);
      if (!conn) { send({ type: 'toast', text: `✕ Not connected to ${msg.peerName}` }); break; }
      let user = ''; try { user = os.userInfo().username; } catch {}
      const a = agents.get(msg.fromId);
      const env = pc.buildEnvelope({ toAgent: msg.toAgent, fromAgent: (a && a.agentName) || '', fromPeer: myPeerName(), fromUser: user, text: msg.text, hop: 0 });
      const v = pc.validateEnvelope(env);
      if (!v.ok) { send({ type: 'toast', text: '✕ ' + v.error }); break; }
      sendPeerEnvelope(conn, env, conn.name);
      break;
    }
    case 'getPeersState': sendPeersState(); break;
    case 'relaunch': if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reloadIgnoringCache(); break;
    case 'fullRestart': app.relaunch(); app.exit(0); break;
    case 'installUpdate': autoUpdater.quitAndInstall(); break;
    case 'checkGitUpdate': checkGitUpdate(); break;
    case 'gitPull': doGitPull(); break;
    case 'approvePr': {
      const url = msg.url;
      if (typeof url !== 'string' || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/.test(url)) break;
      execFile('gh', ['pr', 'review', url, '--approve'],
        { timeout: 15000, windowsHide: true, shell: process.platform === 'win32' }, (err, _o, stderr) => {
          if (err) { send({ type: 'prActionError', url, error: ghErr({ message: ((stderr || '') + err.message).trim() }) }); return; }
          pollPRs(); // approved PR now drops from the list
        });
      break;
    }
    case 'pollPrsNow': pollPRs(); break;
    case 'getModels': fetchModels(); break;
    case 'installGh': {
      if (process.platform !== 'win32') { shell.openExternal('https://cli.github.com').catch(() => {}); break; }
      send({ type: 'toast', text: 'Installing GitHub CLI…' });
      execFile('winget', ['install', '--id', 'GitHub.cli', '-e', '--source', 'winget',
        '--accept-package-agreements', '--accept-source-agreements'],
        { timeout: 300000, windowsHide: true, shell: true }, (err) => {
          // winget puts gh on the machine PATH, which this already-running process
          // won't see — repairGhPath finds it so no restart is needed.
          const dir = repairGhPath();
          if (err && !dir) {
            send({ type: 'toast', text: 'Install failed — opening cli.github.com' });
            shell.openExternal('https://cli.github.com').catch(() => {});
            return;
          }
          ghLogin = null;
          send({ type: 'toast', text: 'GitHub CLI installed' });
          send({ type: 'ghReady' });
          pollPRs();
        });
      break;
    }
    case 'ghAuthLogin': {
      // gh auth login is interactive and prints a one-time code, so it needs a real
      // console — the detached stdio:'ignore' spawn used for `claude` would hide it.
      try {
        const p = process.platform === 'win32'
          ? spawn('cmd', ['/c', 'start', '', 'cmd', '/k', 'gh auth login --web'], { detached: true, stdio: 'ignore' })
          : spawn('sh', ['-c', 'gh auth login --web'], { detached: true, stdio: 'ignore' });
        p.unref();
      } catch (e) { send({ type: 'toast', text: 'Could not start gh auth login' }); break; }
      ghLogin = null; // drop the cached login so the next poll re-reads it
      send({ type: 'toast', text: 'Finish login in the terminal window…' });
      // The browser flow finishes out-of-band, so watch for the login to land and
      // recover on our own rather than making the user hit reload.
      let tries = 0;
      const authWatch = setInterval(async () => {
        if (++tries > 40) return clearInterval(authWatch); // ~2 min
        ghLogin = null;
        if (await fetchGhLogin()) {
          clearInterval(authWatch);
          send({ type: 'toast', text: 'Logged in to GitHub' });
          send({ type: 'ghReady' });
          pollPRs();
        }
      }, 3000);
      break;
    }
    case 'muteRepo': {
      if (typeof msg.repo === 'string') {
        const s = new Set(settings.prMutedRepos || []); s.add(msg.repo);
        settings.prMutedRepos = [...s]; saveState(); pollPRs();
      }
      break;
    }
    case 'unmuteRepo': {
      if (typeof msg.repo === 'string') {
        settings.prMutedRepos = (settings.prMutedRepos || []).filter(r => r !== msg.repo);
        saveState(); pollPRs();
      }
      break;
    }
    case 'snoozePr': {
      if (typeof msg.key === 'string' && typeof msg.untilMs === 'number' && msg.untilMs > Date.now()) {
        const s = settings.prSnoozed || {}; s[msg.key] = msg.untilMs;
        settings.prSnoozed = s; saveState(); pollPRs();
      }
      break;
    }
    case 'unsnoozePr': {
      if (typeof msg.key === 'string') {
        const s = settings.prSnoozed || {}; delete s[msg.key];
        settings.prSnoozed = s; saveState(); pollPRs();
      }
      break;
    }
    case 'mutePr': {
      if (typeof msg.key === 'string') {
        const s = new Set(settings.prMuted || []); s.add(msg.key);
        settings.prMuted = [...s]; saveState(); pollPRs();
      }
      break;
    }
    case 'unmutePr': {
      if (typeof msg.key === 'string') {
        settings.prMuted = (settings.prMuted || []).filter(k => k !== msg.key);
        saveState(); pollPRs();
      }
      break;
    }
    case 'mergePr': {
      const url = msg.url;
      if (typeof url !== 'string' || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/.test(url)) break;
      execFile('gh', ['pr', 'merge', url, '--merge'],
        { timeout: 30000, windowsHide: true, shell: process.platform === 'win32' }, (err, _o, stderr) => {
          if (err) { send({ type: 'prActionError', url, error: ghErr({ message: ((stderr || '') + err.message).trim() }) }); return; }
          pollPRs(); // merged PR drops from the list
        });
      break;
    }
    case 'getTimeline': { const evts = getFullTimeline(msg.id); send({ type: 'timelineData', id: msg.id, events: evts }); break; }
    case 'globalSearch': { const results = globalSearch(msg.query); send({ type: 'searchResults', query: msg.query, results }); break; }
    case 'setTimelineAgent': timelineAgentId = msg.id ?? null; break;
    case 'fetchUsage': fetchUsage(); break;
    case 'getAccountInfo': send({ type: 'accountInfo', ...getCurrentAccountInfo() }); break;
    case 'saveAccount': {
      const data = loadAccounts();
      let creds;
      try { creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8')); } catch { break; }
      const meta = getAccountMeta();
      const email = getAccountEmail();
      const label = msg.label || email || `Account ${data.accounts.length + 1}`;
      const entry = { label, email, meta, credentials: creds };
      const idx = data.accounts.findIndex(a => a.label === label);
      if (idx >= 0) data.accounts[idx] = entry;
      else data.accounts.push(entry);
      data.activeLabel = label;
      saveAccountsFile(data);
      send({ type: 'accountInfo', ...getCurrentAccountInfo() });
      break;
    }
    case 'switchAccount': {
      const data = loadAccounts();
      const target = data.accounts.find(a => a.label === msg.label);
      if (!target) break;
      // Save current credentials under active label before switching
      if (data.activeLabel) {
        try {
          const curCreds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
          const curIdx = data.accounts.findIndex(a => a.label === data.activeLabel);
          if (curIdx >= 0) { data.accounts[curIdx].credentials = curCreds; data.accounts[curIdx].meta = getAccountMeta(); }
        } catch {}
      }
      fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(target.credentials, null, 2));
      data.activeLabel = target.label;
      saveAccountsFile(data);
      _cachedAuthStatus = null;
      refreshAuthStatus(true);
      lastUsage = null;
      send({ type: 'accountInfo', ...getCurrentAccountInfo() });
      send({ type: 'usage', usage: null });
      // Run token verification via claude auth login (opens browser if needed)
      const switchLoginProc = spawn('claude', ['auth', 'login'], { shell: true, stdio: 'ignore', detached: true });
      switchLoginProc.unref();
      let switchPrevToken = getApiKey();
      const switchCheckInterval = setInterval(() => {
        const newToken = getApiKey();
        if (newToken && newToken !== switchPrevToken) {
          clearInterval(switchCheckInterval);
          _cachedAuthStatus = null;
          refreshAuthStatus(true).then(() => {
            const switchData = loadAccounts();
            const switchIdx = switchData.accounts.findIndex(a => a.label === target.label);
            if (switchIdx >= 0) {
              try { switchData.accounts[switchIdx].credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8')); } catch {}
              switchData.accounts[switchIdx].meta = getAccountMeta();
              switchData.accounts[switchIdx].email = getAccountEmail();
              saveAccountsFile(switchData);
            }
            send({ type: 'accountInfo', ...getCurrentAccountInfo() });
            fetchUsage();
          });
        }
      }, 1000);
      setTimeout(() => clearInterval(switchCheckInterval), 120000);
      break;
    }
    case 'addAccount': {
      // Auto-save current credentials before login flow
      const curData = loadAccounts();
      if (getApiKey() && curData.activeLabel) {
        try {
          const curCreds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
          const idx = curData.accounts.findIndex(a => a.label === curData.activeLabel);
          if (idx >= 0) { curData.accounts[idx].credentials = curCreds; curData.accounts[idx].meta = getAccountMeta(); curData.accounts[idx].email = getAccountEmail(); }
          saveAccountsFile(curData);
        } catch {}
      }
      // Run claude auth login — opens browser for OAuth
      const loginProc = spawn('claude', ['auth', 'login'], { shell: true, stdio: 'ignore', detached: true });
      loginProc.unref();
      // Watch credentials file for changes
      let prevToken = getApiKey();
      const checkInterval = setInterval(() => {
        const newToken = getApiKey();
        if (newToken && newToken !== prevToken) {
          clearInterval(checkInterval);
          _cachedAuthStatus = null;
          refreshAuthStatus(true).then(() => {
            const email = getAccountEmail();
            const data = loadAccounts();
            data.activeLabel = null;
            saveAccountsFile(data);
            send({ type: 'accountInfo', ...getCurrentAccountInfo() });
            send({ type: 'accountLoginComplete', email });
          });
        }
      }, 1000);
      // Stop watching after 2 minutes
      setTimeout(() => clearInterval(checkInterval), 120000);
      break;
    }
    case 'removeAccount': {
      const data = loadAccounts();
      data.accounts = data.accounts.filter(a => a.label !== msg.label);
      saveAccountsFile(data);
      send({ type: 'accountInfo', ...getCurrentAccountInfo() });
      break;
    }
    case 'logout': {
      const data = loadAccounts();
      if (data.activeLabel) {
        data.accounts = data.accounts.filter(a => a.label !== data.activeLabel);
      }
      data.activeLabel = null;
      saveAccountsFile(data);
      try { fs.unlinkSync(CREDENTIALS_PATH); } catch {}
      lastUsage = null;
      send({ type: 'accountInfo', ...getCurrentAccountInfo() });
      send({ type: 'usage', usage: null });
      break;
    }
    case 'createTeam': {
      const teamPrompt = buildTeamPrompt(msg.task, msg.roles);
      createAgent(msg.cwd, teamPrompt);
      break;
    }
    case 'focusTeamMember': {
      const team = teams.get(msg.teamName);
      if (!team) break;
      const leadId = team.leadAgentId;
      spawnTerminal(leadId);
      send({ type: 'focused', id: leadId });
      // Type @member-name tag into the lead's terminal for non-lead members
      if (!msg.isLead && msg.memberName) {
        const t = terminals.get(leadId);
        if (t) {
          setTimeout(() => { try { t.write('@' + msg.memberName + ' '); } catch {} }, 300);
        }
      }
      break;
    }
    case 'getAgents': {
      sendFullState();
      break;
    }
  }
}
ipcMain.on('cmd', (_e, msg) => {
  _lastActivity = Date.now();
  handleIpc(msg);
});

// Periodically push stats + scan for new JSONL files (/clear detection)
setInterval(() => {
  for (const [id, a] of agents) send({ type: 'stats', id, stats: a.stats });
  scanForNewJsonlFiles();
  reconcileResumedAgents();
}, 5000);

// Status watchdog — reconcile agents stuck on 'active'. The JSONL transcript is the
// ground truth for "is this agent actually working": if it hasn't grown in
// STATUS_STUCK_MS and no tool is pending, the turn ended without a turn_duration
// event (detached terminal, or process idle/dead at the prompt). Pending tools are
// left alone — a long-running Bash writes nothing meanwhile and isn't idle.
setInterval(() => {
  const now = Date.now();
  for (const [id, a] of agents) {
    if (a.archived || a.isWaiting || a.crashed || a.toolIds.size > 0) continue;
    let mtimeMs;
    try { mtimeMs = fs.statSync(a.jsonlFile).mtimeMs; } catch { continue; }
    if (now - mtimeMs < STATUS_STUCK_MS) continue;
    a.isWaiting = true; a.permSent = false; clrTimer(id, permTimers);
    send({ type: 'status', id, status: 'waiting' });
  }
}, STATUS_STUCK_MS);

// Periodically scan for teams
setInterval(() => scanTeams(), TEAM_POLL_MS);

// Periodically fetch usage — when user is active OR any agent is running OR data is stale
function hasActiveAgents() { for (const a of agents.values()) { if (!a.isWaiting) return true; } return false; }
function isUsageStale() { return !lastUsage || (Date.now() - lastUsage.fetchedAt > USAGE_STALE_MS); }
setInterval(() => { if (isUserActive() || hasActiveAgents() || isUsageStale()) fetchUsage(); }, USAGE_POLL_MS);

// ── Remote (mobile) command handler ──────────────────
function handleRemoteCmd(msg) {
  switch (msg.type) {
    case 'viewAgent': {
      remoteViewingAgent = msg.id;
      const buf = termBuffers.get(msg.id);
      if (buf) wsSend(remoteWs, { type: 'termData', id: msg.id, data: buf });
      break;
    }
    case 'getState': {
      const agentList = [];
      for (const [id, a] of agents) {
        const st = a.isWaiting ? 'waiting' : (a.toolIds.size > 0 || a.hadTools ? 'active' : 'idle');
        agentList.push({
          id, cwd: a.cwd, title: a.title, customName: a.customName,
          agentName: a.agentName, status: st, lastPrompt: a.lastPrompt,
          preview: a.lastText, createdAt: a.createdAt,
          stats: a.stats, spinnerText: a.spinnerText,
        });
      }
      wsSend(remoteWs, { type: 'fullState', agents: agentList });
      break;
    }
    case 'createAgent': createAgent(msg.cwd, msg.prompt); break;
    case 'closeAgent': closeAgent(msg.id); break;
    case 'restartAgent': {
      const a = agents.get(msg.id);
      if (a) {
        const c = a.cwd;
        const savedTitle = a.title || '';
        const savedCustomName = a.customName;
        const savedAgentName = a.agentName;
        closeAgent(msg.id);
        const newId = createAgent(c);
        const na = agents.get(newId);
        if (na && savedAgentName) { na.agentName = savedAgentName; send({ type: 'agentNameChanged', id: newId, agentName: savedAgentName }); }
        if (savedTitle && na) { na.title = savedTitle; na.customName = savedCustomName; send({ type: 'title', id: newId, text: savedTitle, customName: savedCustomName }); saveState(); }
      }
      break;
    }
    case 'termInput': handleTermInput(msg.id, msg.data); break;
    case 'getProjects': {
      const projects = new Set();
      for (const [, a] of agents) if (a.cwd) projects.add(a.cwd);
      wsSend(remoteWs, { type: 'projects', projects: [...projects] });
      break;
    }
  }
}

// ── Remote access HTTP/WebSocket server ──────────────
let remoteServer = null;
let remoteUrl = null;

function startRemoteServer() {
  // Pairing code gates both control channels (/ws for the phone, /peer for other
  // Overlords). Generated once and persisted. This runs after restoreAgents, so
  // saveState() here writes the full agent list, not an empty one.
  if (!settings.peerCode) { settings.peerCode = pc.generatePairingCode(); saveState(); }
  let mobileHtml;
  try { mobileHtml = fs.readFileSync(path.join(__dirname, 'mobile.html'), 'utf-8'); }
  catch { mobileHtml = '<html><body>mobile.html not found</body></html>'; }

  let generateQRSvg;
  try { generateQRSvg = require('./qr.js').generateQRSvg; }
  catch (e) { console.log('[Overlord] QR module not found:', e.message); generateQRSvg = () => '<svg></svg>'; }

  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(mobileHtml);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  server.on('upgrade', (req, socket) => {
    let u;
    try { u = new URL(req.url, 'http://localhost'); } catch { socket.destroy(); return; }
    if (u.pathname === '/peer') { handlePeerUpgrade(req, socket, u); return; }
    if (u.pathname !== '/ws') { socket.destroy(); return; }
    if (!pc.checkCode(settings.peerCode, u.searchParams.get('code'))) { socket.destroy(); return; }
    if (remoteWs && !remoteWs.destroyed) {
      try { remoteWs.end(); } catch {}
      remoteWs = null;
    }
    const ws = wsHandshake(req, socket);
    if (!ws) return;
    remoteWs = ws;
    remoteViewingAgent = null;
    console.log('[Overlord] Mobile client connected');
    handleRemoteCmd({ type: 'getState' });

    let wsBuf = Buffer.alloc(0);
    ws.on('data', (chunk) => {
      wsBuf = Buffer.concat([wsBuf, chunk]);
      while (wsBuf.length >= 2) {
        const frame = wsDecodeFrame(wsBuf);
        if (!frame) break;
        wsBuf = wsBuf.slice(frame.totalLen);
        if (frame.opcode === 0x8) {
          try { ws.end(wsEncodeFrame('')); } catch {}
          ws.destroy();
          if (remoteWs === ws) { remoteWs = null; remoteViewingAgent = null; }
          console.log('[Overlord] Mobile client disconnected');
          return;
        }
        if (frame.opcode === 0x9) {
          const pong = Buffer.alloc(2);
          pong[0] = 0x8a; pong[1] = 0;
          try { ws.write(pong); } catch {}
          continue;
        }
        if (frame.opcode === 0x1) {
          try { handleRemoteCmd(JSON.parse(frame.data)); }
          catch (e) { console.log('[Overlord] Bad remote message:', e.message); }
        }
      }
    });

    ws.on('close', () => {
      if (remoteWs === ws) { remoteWs = null; remoteViewingAgent = null; }
      console.log('[Overlord] Mobile client disconnected');
    });
    ws.on('error', () => {
      if (remoteWs === ws) { remoteWs = null; remoteViewingAgent = null; }
    });
  });

  const tryListen = (port) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && port < REMOTE_PORT + 10) {
        console.log(`[Overlord] Port ${port} in use, trying ${port + 1}`);
        tryListen(port + 1);
      } else {
        console.log(`[Overlord] Remote server failed: ${err.message}`);
      }
    });
    server.listen(port, '0.0.0.0', () => {
      const ip = getLanIp();
      remoteUrl = `http://${ip}:${port}`;
      remotePort = port;
      remoteServer = server;
      // QR embeds the pairing code — a scan connects without typing it
      const qrUrl = `${remoteUrl}/?code=${settings.peerCode}`;
      const svg = generateQRSvg(qrUrl, 4);
      send({ type: 'remoteReady', url: qrUrl, qrSvg: svg });
      console.log(`[Overlord] Remote access: ${remoteUrl}`);
      startPeerClients();
      sendPeersState();
    });
  };
  tryListen(REMOTE_PORT);
}

// ── LAN peers: Overlord ↔ Overlord messaging ──────────
// Transport reuses the remote server (path /peer, same pairing code). Outbound
// dials are hand-rolled HTTP upgrades (stdlib only, like everything else here);
// client→server frames are masked per RFC 6455 (peer-core.js), server→client
// frames reuse the unmasked wsEncodeFrame above. Incoming messages are pasted
// into the target agent's input line WITHOUT submitting — a human presses
// Enter, so two agents can never ping-pong unattended.
let remotePort = REMOTE_PORT;
const peerConns = new Set(); // { ws, isClient, cfg, name, agents, helloDone, lastRecv, pingTimer }
const peerDialers = new Map(); // 'host:port' -> { timer, backoffMs }
const pendingPeerMsgs = new Map(); // agentId -> [envelope] queued while the agent works
const pendingPeerAcks = new Map(); // envelope id -> { peerName, toAgent, timer }
const seenPeerMsgIds = new Set(); // dedupe: both sides may hold a link each
const seenPeerMsgOrder = [];
const PEER_BACKOFF_MIN = 5000, PEER_BACKOFF_MAX = 60000;
const PEER_PING_MS = 25000, PEER_IDLE_MS = 90000, PEER_ACK_TIMEOUT_MS = 10000;

function myPeerName() { return pc.sanitizePeerName(settings.peerName) || pc.sanitizePeerName(os.hostname()) || 'overlord'; }
function connectedPeerNames() { const out = []; for (const c of peerConns) if (c.helloDone && c.name) out.push(c.name); return out; }
function findPeerConn(name) { const n = String(name || '').toLowerCase(); for (const c of peerConns) if (c.helloDone && c.name && c.name.toLowerCase() === n) return c; return null; }
function wsSendPeer(conn, obj) { if (!conn || !conn.ws || conn.ws.destroyed) return; const s = JSON.stringify(obj); try { conn.ws.write(conn.isClient ? pc.wsEncodeFrameMasked(s) : wsEncodeFrame(s)); } catch {} }

function peerRoster() {
  const out = [];
  for (const [, a] of agents) { if (a.agentName && !a.archived) out.push({ agentName: a.agentName, title: a.title || '', status: a.isWaiting ? 'idle' : 'active' }); }
  return out;
}

function sanitizeRoster(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const a of list.slice(0, 100)) {
    if (!a || typeof a.agentName !== 'string' || !a.agentName) continue;
    out.push({ agentName: a.agentName.slice(0, 64), title: String(a.title || '').slice(0, 120), status: a.status === 'idle' ? 'idle' : 'active' });
  }
  return out;
}

function sendPeersState() {
  const cfgPeers = Array.isArray(settings.peers) ? settings.peers : [];
  const rows = cfgPeers.map(p => {
    const conn = [...peerConns].find(c => c.helloDone && c.cfg && c.cfg.host === p.host && c.cfg.port === p.port) || (p.name ? findPeerConn(p.name) : null);
    return { host: p.host, port: p.port, name: (conn && conn.name) || p.name || `${p.host}:${p.port}`, connected: !!conn, agents: conn ? conn.agents : [] };
  });
  for (const c of peerConns) { // inbound-only peers (they added us, we never added them)
    if (!c.helloDone || c.cfg) continue;
    if (rows.some(r => r.name.toLowerCase() === (c.name || '').toLowerCase())) continue;
    rows.push({ host: '', port: 0, name: c.name, connected: true, inbound: true, agents: c.agents });
  }
  send({ type: 'peersState', enabled: !!settings.peersEnabled, name: myPeerName(), code: settings.peerCode || '', lanIp: getLanIp(), port: remotePort, peers: rows });
}

// Roster push: poll-and-diff instead of hooking every agent mutation site.
let _lastRosterJson = '';
setInterval(() => {
  if (peerConns.size === 0) { _lastRosterJson = ''; return; }
  const json = JSON.stringify(peerRoster());
  if (json === _lastRosterJson) return;
  _lastRosterJson = json;
  for (const c of peerConns) if (c.helloDone) wsSendPeer(c, { type: 'peerAgents', agents: JSON.parse(json) });
}, 5000);

function closePeerConn(conn) {
  if (!peerConns.has(conn)) return; // 'close' event after an explicit close
  peerConns.delete(conn);
  if (conn.pingTimer) clearInterval(conn.pingTimer);
  try { conn.ws.destroy(); } catch {}
  if (conn.helloDone) flog(`peer disconnected: ${conn.name}`);
  sendPeersState();
  if (conn.isClient && conn.cfg) schedulePeerRedial(conn.cfg);
}

function attachPeerSocket(ws, { isClient, cfg }) {
  const conn = { ws, isClient, cfg: cfg || null, name: null, agents: [], helloDone: false, lastRecv: Date.now(), pingTimer: null };
  peerConns.add(conn);
  let buf = Buffer.alloc(0);
  ws.on('data', (chunk) => {
    conn.lastRecv = Date.now();
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const frame = wsDecodeFrame(buf);
      if (!frame) break;
      buf = buf.slice(frame.totalLen);
      if (frame.opcode === 0x8) { closePeerConn(conn); return; }
      if (frame.opcode === 0x9) { // ping → pong (masked when we're the client side)
        try { ws.write(isClient ? pc.wsEncodeFrameMasked('', 0xA) : Buffer.from([0x8a, 0])); } catch {}
        continue;
      }
      if (frame.opcode === 0xA) continue; // pong — lastRecv already updated
      if (frame.opcode === 0x1) {
        try { handlePeerMsg(conn, JSON.parse(frame.data)); }
        catch (e) { flog('bad peer message:', e.message); }
      }
    }
  });
  ws.on('close', () => closePeerConn(conn));
  ws.on('error', () => closePeerConn(conn));
  conn.pingTimer = setInterval(() => {
    if (ws.destroyed || Date.now() - conn.lastRecv > PEER_IDLE_MS) { closePeerConn(conn); return; }
    if (isClient) { try { ws.write(pc.wsEncodePingMasked()); } catch {} }
  }, PEER_PING_MS);
  return conn;
}

function handlePeerUpgrade(req, socket, u) {
  if (!settings.peersEnabled) { socket.destroy(); return; }
  if (!pc.checkCode(settings.peerCode, u.searchParams.get('code'))) { socket.destroy(); return; }
  const ws = wsHandshake(req, socket);
  if (!ws) return;
  attachPeerSocket(ws, { isClient: false });
}

function handlePeerMsg(conn, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'peerHello') {
    const name = pc.sanitizePeerName(msg.name);
    if (!name || name.toLowerCase() === myPeerName().toLowerCase()) { closePeerConn(conn); return; }
    // a same-direction duplicate for this name replaces the old link
    for (const c of [...peerConns]) { if (c !== conn && c.name && c.name.toLowerCase() === name.toLowerCase() && c.isClient === conn.isClient) closePeerConn(c); }
    conn.name = name;
    conn.agents = sanitizeRoster(msg.agents);
    conn.helloDone = true;
    if (!conn.isClient) wsSendPeer(conn, { type: 'peerHello', name: myPeerName(), version: app.getVersion(), agents: peerRoster() });
    flog(`peer connected: ${name}${conn.isClient ? ' (outbound)' : ' (inbound)'}`);
    sendPeersState();
    return;
  }
  if (!conn.helloDone) { closePeerConn(conn); return; } // hello must come first
  if (msg.type === 'peerAgents') { conn.agents = sanitizeRoster(msg.agents); sendPeersState(); return; }
  if (msg.type === 'peerMessage') {
    const v = pc.validateEnvelope(msg);
    if (!v.ok) { wsSendPeer(conn, { type: 'peerAck', id: (msg && typeof msg.id === 'string') ? msg.id.slice(0, 64) : '', status: 'rejected', error: v.error }); return; }
    if (seenPeerMsgIds.has(msg.id)) return; // duplicate over a second link
    seenPeerMsgIds.add(msg.id); seenPeerMsgOrder.push(msg.id);
    if (seenPeerMsgOrder.length > 1000) seenPeerMsgIds.delete(seenPeerMsgOrder.shift());
    msg.fromPeer = conn.name; // identity comes from the authenticated link, never the payload
    let target = null;
    for (const [id, a] of agents) { if (a.agentName && !a.archived && a.agentName.toLowerCase() === msg.toAgent.toLowerCase()) { target = id; break; } }
    if (target === null) { wsSendPeer(conn, { type: 'peerAck', id: msg.id, status: 'no-such-agent' }); return; }
    wsSendPeer(conn, { type: 'peerAck', id: msg.id, status: deliverPeerMessage(target, msg) });
    return;
  }
  if (msg.type === 'peerAck') {
    const p = pendingPeerAcks.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer); pendingPeerAcks.delete(msg.id);
    const who = `@${p.toAgent} on ${p.peerName}`;
    if (msg.status === 'delivered') send({ type: 'toast', text: `✉ Delivered to ${who}` });
    else if (msg.status === 'queued') send({ type: 'toast', text: `✉ Queued for ${who} — agent is busy, delivers when idle` });
    else if (msg.status === 'no-such-agent') send({ type: 'toast', text: `✕ No agent named ${who}` });
    else send({ type: 'toast', text: `✕ ${who}: ${msg.error || msg.status || 'rejected'}` });
  }
}

function deliverPeerMessage(agentId, env) {
  const a = agents.get(agentId);
  if (!a) return 'no-such-agent';
  notifyPeerMessage(agentId, env);
  send({ type: 'peerMsg', id: agentId, fromAgent: env.fromAgent, fromPeer: env.fromPeer });
  // The Claude Code input box accepts a paste at any time (mid-turn it just sits
  // there unsubmitted), so deliver whenever a live pty exists. Queue only for
  // agents with no terminal (dead/restored) — flushed by the turn-end hooks
  // once the terminal is back.
  if (!terminals.has(agentId)) {
    const q = pendingPeerMsgs.get(agentId) || [];
    q.push(env); if (q.length > 50) q.shift();
    pendingPeerMsgs.set(agentId, q);
    return 'queued';
  }
  injectPeerMessage(agentId, env);
  return 'delivered';
}

// Bracketed paste: the header+text land in the input box without submitting —
// the human reads, optionally edits, and presses Enter themselves.
function injectPeerMessage(agentId, env) {
  handleTermInput(agentId, '\x1b[200~' + pc.buildPeerHeader(env) + '\x1b[201~');
}

function flushPeerMsgs(id) {
  const q = pendingPeerMsgs.get(id);
  if (!q || q.length === 0) return;
  if (!terminals.has(id)) return; // no pty yet — flush fires again on the next turn end
  pendingPeerMsgs.delete(id);
  for (const env of q) injectPeerMessage(id, env);
}

function notifyPeerMessage(id, env) {
  if (!settings.notifications) return;
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) mainWindow.flashFrame(true);
  if (!Notification.isSupported()) return;
  const a = agents.get(id);
  const from = (env.fromAgent ? '@' + env.fromAgent + ' ' : '') + 'on ' + env.fromPeer;
  const n = new Notification({ title: `✉ Message from ${from}`, body: `${(a && (a.agentName || a.title)) || 'Agent ' + id}: ${env.text.slice(0, 120)}`, silent: !settings.notificationSound });
  n.on('click', () => { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); send({ type: 'focusFromNotification', id }); } });
  n.show();
}

function sendRemoteMentionMessages(id, text, remote) {
  const a = agents.get(id);
  let user = ''; try { user = os.userInfo().username; } catch {}
  for (const r of remote) {
    const conn = findPeerConn(r.peerName);
    if (!conn) { send({ type: 'toast', text: `✕ Not connected to ${r.peerName}` }); continue; }
    const env = pc.buildEnvelope({ toAgent: r.agentName, fromAgent: (a && a.agentName) || '', fromPeer: myPeerName(), fromUser: user, text, hop: 0 });
    sendPeerEnvelope(conn, env, r.peerName);
  }
}

function sendPeerEnvelope(conn, env, peerName) {
  wsSendPeer(conn, env);
  const timer = setTimeout(() => {
    pendingPeerAcks.delete(env.id);
    send({ type: 'toast', text: `✕ No response from ${peerName} — message may not have arrived` });
  }, PEER_ACK_TIMEOUT_MS);
  pendingPeerAcks.set(env.id, { peerName, toAgent: env.toAgent, timer });
}

function peerKey(cfg) { return cfg.host + ':' + cfg.port; }

function schedulePeerRedial(cfg) {
  if (!settings.peersEnabled) return;
  if (!(settings.peers || []).some(p => p.host === cfg.host && p.port === cfg.port)) return; // peer was removed
  const key = peerKey(cfg);
  let d = peerDialers.get(key);
  if (!d) { d = { timer: null, backoffMs: PEER_BACKOFF_MIN }; peerDialers.set(key, d); }
  if (d.timer) return;
  d.timer = setTimeout(() => { d.timer = null; dialPeer(cfg); }, d.backoffMs);
  d.backoffMs = Math.min(PEER_BACKOFF_MAX, d.backoffMs * 2);
}

function dialPeer(cfg) {
  if (!settings.peersEnabled) return;
  const key = peerKey(cfg);
  for (const c of peerConns) if (c.isClient && c.cfg && peerKey(c.cfg) === key) return; // already connected outbound
  let d = peerDialers.get(key);
  if (!d) { d = { timer: null, backoffMs: PEER_BACKOFF_MIN }; peerDialers.set(key, d); }
  const wsKey = pc.makeWsKey();
  const req = http.request({
    host: cfg.host, port: cfg.port,
    path: '/peer?code=' + encodeURIComponent(cfg.code),
    headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': wsKey, 'Sec-WebSocket-Version': '13' },
    timeout: 8000,
  });
  req.on('upgrade', (res, socket) => {
    if (!pc.checkWsAccept(wsKey, res.headers['sec-websocket-accept'])) { socket.destroy(); schedulePeerRedial(cfg); return; }
    d.backoffMs = PEER_BACKOFF_MIN;
    const conn = attachPeerSocket(socket, { isClient: true, cfg });
    wsSendPeer(conn, { type: 'peerHello', name: myPeerName(), version: app.getVersion(), agents: peerRoster() });
  });
  req.on('response', (res) => { flog(`peer dial ${key}: HTTP ${res.statusCode} instead of upgrade (wrong code, peers disabled, or old Overlord on the other side)`); req.destroy(); schedulePeerRedial(cfg); });
  req.on('timeout', () => req.destroy(new Error('peer dial timeout')));
  req.on('error', () => schedulePeerRedial(cfg));
  req.end();
}

function startPeerClients() {
  if (!settings.peersEnabled) return;
  for (const p of (settings.peers || [])) dialPeer(p);
}

function stopAllPeers() {
  for (const [, d] of peerDialers) clearTimeout(d.timer);
  peerDialers.clear();
  for (const c of [...peerConns]) {
    peerConns.delete(c); // delete first so closePeerConn's redial path never runs
    if (c.pingTimer) clearInterval(c.pingTimer);
    try { c.ws.destroy(); } catch {}
  }
  sendPeersState();
}

// ── Window ─────────────────────────────────────────────
let _boundsTimer = null;
function saveWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
  settings.isMaximized = mainWindow.isMaximized();
  if (!settings.isMaximized) settings.windowBounds = mainWindow.getBounds();
  clearTimeout(_boundsTimer);
  _boundsTimer = setTimeout(() => saveState(), 500);
}

app.whenReady().then(() => {
  // Windows needs an explicit AppUserModelID or toast notifications silently no-op.
  if (process.platform === 'win32') app.setAppUserModelId('com.overlord.claude');
  // Load settings early (fast) so window bounds are correct, but defer heavy agent restoration
  const state = loadState();
  settings = { ...settings, ...state.settings };
  const bounds = settings.windowBounds || {};
  const opts = {
    width: bounds.width || 750, height: bounds.height || 800,
    minWidth: 500, minHeight: 400,
    title: 'Overlord',
    backgroundColor: '#1e1e2e',
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  };
  if (bounds.x !== undefined && bounds.y !== undefined) { opts.x = bounds.x; opts.y = bounds.y; }
  mainWindow = new BrowserWindow(opts);
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, _permission, cb) => cb(true));
  if (settings.isMaximized) mainWindow.maximize();
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.setMenuBarVisibility(false);
  // Show window as soon as the page is painted — don't wait for agent restoration
  mainWindow.once('ready-to-show', () => mainWindow.show());
  // Restore agents after window is visible (heavy JSONL parsing + process cleanup)
  let _didRestore = false;
  mainWindow.webContents.on('did-finish-load', () => {
    if (!_didRestore) {
      _didRestore = true;
      restoreAgents(state);
      startRemoteServer();
      armPrTimer();
      armActionsTimer();
    }
    // Runs on every load incl. renderer reload — repaints from in-memory state
    // so a reload (to pick up index.html changes) keeps all live sessions.
    sendFullState();
  });
  mainWindow.on('focus', () => { mainWindow.flashFrame(false); _windowFocused = true; _lastActivity = Date.now(); fetchUsage(); });
  mainWindow.on('blur', () => { _windowFocused = false; });
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      mainWindow.webContents.toggleDevTools();
    }
  });
  mainWindow.on('resize', saveWindowBounds);
  mainWindow.on('move', saveWindowBounds);
  mainWindow.on('closed', () => {
    saveState();
    mainWindow = null;
  });
  // Check for updates — only runs when packaged (not in dev, not in a sandboxed test instance)
  if (app.isPackaged && !process.env.OVERLORD_STATE_DIR) {
    setTimeout(() => autoUpdater.checkForUpdatesAndNotify(), 3000);
    // Re-check every minute so a long-running app catches new releases without a restart.
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 60 * 1000);
  } else if (isGitCheckout() && !process.env.OVERLORD_STATE_DIR) {
    // Source checkout: same idea, different mechanism — watch origin/master.
    setTimeout(checkGitUpdate, 4000);
    setInterval(checkGitUpdate, 5 * 60 * 1000);
  }
});
app.on('before-quit', () => {
  if (remoteServer) { try { remoteServer.close(); } catch {} }
  if (remoteWs) { try { remoteWs.destroy(); } catch {} }
  // Spawn detached Claude processes for active agents so they survive the app restart.
  // The detached process continues the current turn headlessly; on restore the app
  // kills it via saved PID before reconnecting.
  const detachedPids = new Map(); // sessionId -> pid
  for (const [id, a] of agents) {
    if (!terminals.has(id)) continue; // no live terminal, nothing to preserve
    const wasActive = !a.isWaiting;
    if (!wasActive) continue;
    const skip = settings.bypassPermissions ? ' --dangerously-skip-permissions' : '';
    const cmd = `claude --resume ${a.sessionId}${skip}`;
    try {
      const sh = process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL || 'bash');
      const args = process.platform === 'win32' ? ['/c', cmd] : ['-c', cmd];
      const child = spawn(sh, args, { cwd: safeCwd(a.cwd), detached: true, stdio: 'ignore', env: { ...process.env } });
      child.unref();
      detachedPids.set(a.sessionId, child.pid);
      console.log(`[Overlord] Spawned detached Claude for agent ${id} (session ${a.sessionId}, pid ${child.pid})`);
    } catch (e) {
      console.log(`[Overlord] Failed to spawn detached Claude for agent ${id}:`, e.message);
    }
  }
  // Update state file with detached PIDs so next startup can kill them
  if (detachedPids.size > 0) {
    try {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      for (const entry of (data.agents || [])) {
        const dpid = detachedPids.get(entry.sessionId);
        if (dpid) entry.pid = dpid;
      }
      fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(data, null, 2));
      fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
    } catch (e) {
      console.log('[Overlord] Failed to save detached PIDs:', e.message);
    }
  }
});
app.on('window-all-closed', () => app.quit());
