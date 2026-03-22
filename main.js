const { app, BrowserWindow, ipcMain, dialog, shell, Notification, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn, exec, execSync } = require('child_process');
const pty = require('node-pty');

// ── Constants ──────────────────────────────────────────
const JSONL_POLL_MS = 1000;
const TOOL_DONE_DELAY_MS = 300;
const PERMISSION_TIMER_MS = 7000;
const TEXT_IDLE_DELAY_MS = 5000;
const PREVIEW_MAX = 200;
const PROMPT_HISTORY_MAX = 50;
const PROMPT_BRIEF_MAX = 150;
const TITLE_MODEL = 'claude-haiku-4-5-20251001';
const TITLE_REGEN_TURNS = 3;
const EXEMPT = new Set(['Task', 'Agent', 'AskUserQuestion', 'CronCreate', 'CronDelete', 'CronList']);
const SPINNER_DEBOUNCE_MS = 150;
const MAX_CRASH_RETRIES = 3;
const CRASH_RESUME_DELAY_MS = 2000;
const USAGE_POLL_MS = 60000;
const USAGE_TIMEOUT_MS = 15000;
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
  if (model.includes('opus')) return 'opus';
  if (model.includes('haiku')) return 'haiku';
  return 'sonnet';
}

const STATE_DIR = path.join(os.homedir(), '.pixel-agents');
const STATE_FILE = path.join(STATE_DIR, 'overlord-state.json');

let mainWindow = null;
const agents = new Map();
const terminals = new Map();
const watchers = new Map();
const polls = new Map();
const waitTimers = new Map();
const permTimers = new Map();
const serverPorts = new Map(); // agentId -> Map(port -> url)
const remoteControlAgents = new Set(); // agentIds with remote control active
const teams = new Map(); // teamName -> { name, leadAgentId, leadSessionId, members[], tasks[] }
const agentTeamMap = new Map(); // agentId -> teamName
const knownJsonlFiles = new Map(); // projectDir -> Set<filePath>
let nextId = 1;

function send(data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('msg', data);
}
function logToRenderer(...args) {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  console.log(msg);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('main-log', msg);
}

function sendFullState() {
  send({ type: 'settings', settings });
  for (const [id, a] of agents) {
    send({ type: 'agentCreated', id, cwd: a.cwd, sessionId: a.sessionId, title: a.title, createdAt: a.createdAt, agentName: a.agentName });
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
    const ports = serverPorts.get(id);
    if (ports) { for (const [port, url] of ports) send({ type: 'serverDetected', id, port, url }); }
    if (remoteControlAgents.has(id)) send({ type: 'remoteControl', id, active: true });
    if (a.cronCount > 0) send({ type: 'looping', id, active: true, count: a.cronCount });
    if (a.compacting) send({ type: 'compacting', id, active: true });
  }
  for (const [, teamData] of teams) {
    send({ type: 'teamDetected', team: { name: teamData.name, leadAgentId: teamData.leadAgentId, members: teamData.members, tasks: teamData.tasks } });
  }
  if (lastUsage) send({ type: 'usage', usage: lastUsage });
  fetchUsage();
}

function claudeDir(projectPath) {
  return path.join(os.homedir(), '.claude', 'projects', projectPath.replace(/[:\\/\s]/g, '-'));
}

function deriveTitle(text) {
  const clean = text.replace(/[\n\r]+/g, ' ').trim();
  const words = clean.split(/\s+/).slice(0, 5).join(' ');
  return words.length > 40 ? words.slice(0, 40) + '\u2026' : words;
}

function killProcessTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {} // Process may already be dead
}

function killSessionProcesses(sessionId) {
  if (!sessionId) return;
  try {
    if (process.platform === 'win32') {
      const out = execSync(`wmic process where "CommandLine like '%${sessionId}%'" get ProcessId /format:csv`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000 });
      for (const line of out.split(/[\r\n]+/)) {
        const parts = line.trim().split(',');
        const pid = parseInt(parts[parts.length - 1], 10);
        if (pid && pid !== process.pid) {
          try { execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' }); } catch {}
        }
      }
    } else {
      try { execSync(`pkill -f "${sessionId}"`, { stdio: 'ignore' }); } catch {}
    }
  } catch {}
}

// Async (non-blocking) versions for restore — won't freeze the UI
function killProcessTreeAsync(pid) {
  if (!pid) return Promise.resolve();
  return new Promise(resolve => {
    if (process.platform === 'win32') {
      exec(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }, () => resolve());
    } else {
      try { process.kill(pid, 'SIGTERM'); } catch {}
      resolve();
    }
  });
}

function killSessionProcessesAsync(sessionId) {
  if (!sessionId) return Promise.resolve();
  return new Promise(resolve => {
    if (process.platform === 'win32') {
      exec(`wmic process where "CommandLine like '%${sessionId}%'" get ProcessId /format:csv`, { encoding: 'utf-8', timeout: 5000 }, (err, out) => {
        if (err || !out) return resolve();
        const kills = [];
        for (const line of out.split(/[\r\n]+/)) {
          const parts = line.trim().split(',');
          const pid = parseInt(parts[parts.length - 1], 10);
          if (pid && pid !== process.pid) {
            kills.push(new Promise(r => exec(`taskkill /PID ${pid} /F`, { stdio: 'ignore' }, () => r())));
          }
        }
        Promise.all(kills).then(() => resolve());
      });
    } else {
      exec(`pkill -f "${sessionId}"`, { stdio: 'ignore' }, () => resolve());
    }
  });
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

function clearServers(id) {
  const ports = serverPorts.get(id);
  if (ports && ports.size > 0) {
    serverPorts.delete(id);
    send({ type: 'serversClear', id });
  }
}

// ── Remote control detection ──────────────────────────
// Detected via MCP tool names in JSONL, not terminal output (which includes conversation text)
const RC_TOOLS = new Set(['Snapshot', 'Click', 'Type', 'Scroll', 'Move', 'Shortcut', 'App', 'Shell', 'Wait', 'Scrape']);
function detectRemoteControl(id, toolName) {
  if (remoteControlAgents.has(id)) return;
  if (RC_TOOLS.has(toolName)) {
    remoteControlAgents.add(id);
    send({ type: 'remoteControl', id, active: true });
    console.log(`[Overlord] Remote control detected for agent ${id} (tool: ${toolName})`);
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

function setPrompt(id, a, text) {
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
        // Completion messages like "Sautéed for 36s" or "Cooked for 2m 44s" mean the turn is done — don't treat as active spinner
        if (/\bfor\s+\d+[smh]/i.test(text)) return;
        const a = agents.get(id);
        if (a && a.spinnerText !== text) {
          a.spinnerText = text;
          if (a.isWaiting) { a.isWaiting = false; clrTimer(id, waitTimers); send({ type: 'status', id, status: 'active' }); }
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
const SESSION_HEAD_BYTES = 16384;

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
        if (txt) return [{ type: 'prompt', ts, text: txt.length > 200 ? txt.slice(0, 200) + '\u2026' : txt }];
      } else if (typeof c === 'string' && c.trim()) {
        const txt = c.trim();
        return [{ type: 'prompt', ts, text: txt.length > 200 ? txt.slice(0, 200) + '\u2026' : txt }];
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

async function scanSessions() {
  const claudeBase = path.join(os.homedir(), '.claude', 'projects');
  const result = [];
  const activeIds = new Set([...agents.values()].map(a => a.sessionId));
  let dirs;
  try { dirs = await fs.promises.readdir(claudeBase); } catch { return []; }
  for (const dir of dirs) {
    const dirPath = path.join(claudeBase, dir);
    let stat;
    try { stat = await fs.promises.stat(dirPath); } catch { continue; }
    if (!stat.isDirectory()) continue;
    let files;
    try { files = await fs.promises.readdir(dirPath); } catch { continue; }
    const jsonls = files.filter(f => f.endsWith('.jsonl'));
    for (const file of jsonls) {
      const sessionId = file.replace('.jsonl', '');
      const filePath = path.join(dirPath, file);
      try {
        const meta = await extractSessionMeta(filePath, sessionId);
        if (meta) {
          meta.projectHash = dir;
          meta.isActive = activeIds.has(sessionId);
          result.push(meta);
        }
      } catch {}
    }
  }
  return result;
}

async function extractSessionMeta(filePath, sessionId) {
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size === 0) return null;
    const fd = await fs.promises.open(filePath, 'r');
    try {
      // Read head for first prompt and cwd
      const headSize = Math.min(stat.size, SESSION_HEAD_BYTES);
      const headBuf = Buffer.alloc(headSize);
      await fd.read(headBuf, 0, headSize, 0);
      const headText = headBuf.toString('utf-8');
      const headLines = headText.split('\n').filter(l => l.trim());

      let cwd = '', firstPrompt = '', title = '', date = null;
      let turns = 0, inTok = 0, outTok = 0, modelFam = 'sonnet';

      // Parse head lines
      for (const line of headLines) {
        try {
          const r = JSON.parse(line);
          if (!date && r.timestamp) date = r.timestamp;
          if (!cwd && r.cwd) cwd = r.cwd;
          if (r.type === 'user' && !firstPrompt) {
            const c = r.message?.content;
            if (typeof c === 'string' && c.trim()) firstPrompt = c.trim();
            else if (Array.isArray(c)) {
              const txt = c.filter(b => b.type === 'text').map(b => b.text || '').join('').trim();
              if (txt) firstPrompt = txt;
            }
          }
          if (r.type === 'assistant' && r.message?.model) modelFam = modelFamily(r.message.model);
          if (r.type === 'assistant' && r.message?.usage) {
            const u = r.message.usage;
            inTok += u.input_tokens || 0;
            outTok += u.output_tokens || 0;
          }
          if (r.type === 'system' && r.subtype === 'turn_duration') turns++;
        } catch {}
      }

      // If file is larger than head, read tail for more accurate stats
      if (stat.size > SESSION_HEAD_BYTES) {
        const tailSize = Math.min(stat.size - SESSION_HEAD_BYTES, SESSION_HEAD_BYTES);
        const tailBuf = Buffer.alloc(tailSize);
        await fd.read(tailBuf, 0, tailSize, stat.size - tailSize);
        const tailText = tailBuf.toString('utf-8');
        // Skip first partial line
        const nlIdx = tailText.indexOf('\n');
        const tailLines = (nlIdx >= 0 ? tailText.slice(nlIdx + 1) : tailText).split('\n').filter(l => l.trim());
        for (const line of tailLines) {
          try {
            const r = JSON.parse(line);
            if (r.type === 'assistant' && r.message?.usage) {
              const u = r.message.usage;
              inTok += u.input_tokens || 0;
              outTok += u.output_tokens || 0;
            }
            if (r.type === 'assistant' && r.message?.model) modelFam = modelFamily(r.message.model);
            if (r.type === 'system' && r.subtype === 'turn_duration') turns++;
          } catch {}
        }
      }

      if (!firstPrompt && !turns) return null; // empty/useless session
      if (firstPrompt.length > 150) firstPrompt = firstPrompt.slice(0, 150) + '\u2026';
      title = deriveTitle(firstPrompt || 'Untitled');

      return { sessionId, cwd, firstPrompt, title, date: date || stat.mtime.toISOString(), turns, inTok, outTok, modelFamily: modelFam, size: stat.size };
    } finally { await fd.close(); }
  } catch { return null; }
}

// ── State persistence ─────────────────────────────────
let settings = { layout: 'bottom', zoom: 100, bypassPermissions: true, notifications: true, planBudget: 100 };

function saveState() {
  const agentEntries = [];
  for (const [id, a] of agents) {
    const wasActive = !a.isWaiting;
    let jsonlSize = 0;
    try { jsonlSize = fs.statSync(a.jsonlFile).size; } catch {}
    const termProc = terminals.get(id);
    agentEntries.push({ cwd: a.cwd, sessionId: a.sessionId, lastPrompt: a.lastPrompt, lastText: a.lastText, title: a.title, customName: a.customName || false, createdAt: a.createdAt, wasActive, jsonlSize, pid: termProc?.pid || null, agentName: a.agentName, stats: a.stats, promptHistory: a.promptHistory, cronCount: a.cronCount });
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
      stats: savedStats,
    };
    agents.set(id, agent);
    if (!agent.agentName) agent.agentName = pickAgentName();
    restoredNames.add(agent.agentName);
    agentEntries.push({ id, entry });
    console.log(`[Overlord] Restored agent ${id}: session=${sessionId} cwd=${cwd}`);
  }

  // ── Phase 2: Async — kill orphans, parse JSONL, auto-resume each agent without blocking UI ──
  for (const { id, entry } of agentEntries) {
    const agent = agents.get(id);
    if (!agent) continue;

    // Kick off async cleanup per agent
    (async () => {
      // Kill orphaned processes without blocking the event loop
      if (entry.pid) {
        await killProcessTreeAsync(entry.pid);
        console.log(`[Overlord] Killed orphan PID ${entry.pid} for session ${entry.sessionId}`);
      }
      await killSessionProcessesAsync(entry.sessionId);

      if (!agents.has(id)) return; // closed while we were killing

      // If no saved stats, rebuild from JSONL (legacy state files)
      if (!entry.stats && fs.existsSync(agent.jsonlFile)) {
        try {
          const content = fs.readFileSync(agent.jsonlFile, 'utf-8');
          const lines = content.split('\n').filter(l => l.trim());
          for (const line of lines) {
            try {
              const r = JSON.parse(line);
              if (r.type === 'assistant' && r.message?.usage) {
                if (r.message.model) agent.stats.modelFamily = modelFamily(r.message.model);
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
                    detectRemoteControl(id, b.name);
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
                if (pTxt) {
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

      // Auto-resume: spawn terminal after a short delay to let session locks release
      if (agents.has(id)) {
        console.log(`[Overlord] Auto-resuming agent ${id}`);
        await new Promise(r => setTimeout(r, 1500));
        if (agents.has(id)) spawnTerminal(id);
      }
    })();
  }
}

function handleTermExit(id, exitCode) {
  const a = agents.get(id);
  if (!a) return;
  terminals.delete(id);
  // If we're retrying due to --resume failure, don't treat as crash or send termExit
  if (a._resumeFailed && a._resumeRetrying) { a._resumeRetrying = false; return; }
  // Crash = non-zero exit while agent was not idle/waiting
  const wasActive = !a.isWaiting && (a.toolIds.size > 0 || a.hadTools);
  const crashed = exitCode !== 0 && exitCode !== undefined && wasActive;
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

// Auto-accept context compaction prompts from Claude CLI
function autoCompactWatcher(id, proc) {
  let buf = '';
  let lastCompactTime = 0;
  return (d) => {
    buf += d;
    if (buf.length > 4096) buf = buf.slice(-2048);
    const clean = buf.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    // Match various compact prompt patterns: "compact...? Yes", "auto-compact", "compact conversation"
    if (/compact/i.test(clean) && /(yes|❯|>\s*yes)/i.test(clean)) {
      const now = Date.now();
      if (now - lastCompactTime < 5000) return; // debounce
      lastCompactTime = now;
      buf = '';
      console.log(`[Overlord] Auto-accepting compact for agent ${id}`);
      setTimeout(() => { try { proc.write('\r'); } catch {} }, 200);
    }
  };
}

function spawnTerminal(id) {
  if (terminals.has(id)) return; // already running
  const a = agents.get(id);
  if (!a) return;

  // If an orphaned Claude process is still writing, don't spawn a conflicting --resume.
  // Show a message and wait for it to finish (detected via turn_duration in JSONL watcher).
  if (a.orphanAlive) {
    send({ type: 'termData', id, data: '\x1b[33m[Agent is still running from previous session \u2014 waiting for current turn to finish...]\x1b[0m\r\n' });
    return;
  }

  // Kill any lingering process holding this session lock
  killSessionProcesses(a.sessionId);

  const hasJsonl = fs.existsSync(a.jsonlFile);
  const skip = settings.bypassPermissions ? ' --dangerously-skip-permissions' : '';
  const useResume = hasJsonl && !a._resumeFailed;
  const claudeCmd = useResume ? `claude --resume ${a.sessionId}${skip}` : `claude --session-id ${a.sessionId}${skip}`;
  const sh = process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL || 'bash');
  const args = process.platform === 'win32' ? `/k ${claudeCmd}` : ['-c', claudeCmd];
  try {
    const proc = pty.spawn(sh, args, { name: 'xterm-256color', cols: 120, rows: 30, cwd: a.cwd, env: { ...process.env } });
    terminals.set(id, proc);
    const compactWatch = autoCompactWatcher(id, proc);
    let resumeErrorBuf = '';
    proc.onData((d) => {
      try { send({ type: 'termData', id, data: d }); scanForServers(id, d); extractSpinnerText(id, d); } catch {}
      compactWatch(d);
      // Detect resume errors and retry
      if (!a._resumeHandled) {
        resumeErrorBuf += d;
        if (resumeErrorBuf.length > 4096) resumeErrorBuf = resumeErrorBuf.slice(-2048);
        const clean = resumeErrorBuf.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
        if (useResume && !a._resumeFailed && /No conversation found with session ID/i.test(clean)) {
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
              killSessionProcesses(a.sessionId);
              spawnTerminal(id);
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
    stats: { inTok: 0, outTok: 0, cacheTok: 0, cacheRead: 0, ctxTok: 0, turns: 0, durMs: 0, tools: {}, files: 0, modelFamily: 'sonnet' },
  };
  agents.set(id, agent);

  const skip = settings.bypassPermissions ? ' --dangerously-skip-permissions' : '';
  const claudeCmd = `claude --session-id ${sessionId}${skip}`;
  const shell = process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL || 'bash');
  const shellArgs = process.platform === 'win32' ? `/k ${claudeCmd}` : ['-c', claudeCmd];
  send({ type: 'agentCreated', id, cwd, sessionId, createdAt: agent.createdAt, agentName: agent.agentName });
  send({ type: 'focused', id });

  const agentEnv = { ...process.env, CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' };
  try {
    const proc = pty.spawn(shell, shellArgs, { name: 'xterm-256color', cols: 120, rows: 30, cwd, env: agentEnv });
    terminals.set(id, proc);
    const compactWatch = autoCompactWatcher(id, proc);
    let promptSent = !initialPrompt;
    proc.onData((d) => {
      try { send({ type: 'termData', id, data: d }); scanForServers(id, d); extractSpinnerText(id, d); } catch {}
      compactWatch(d);
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
  clrTimer(id, waitTimers); clrTimer(id, permTimers);
  lastNotifyTimes.delete(id);
  clearServers(id);
  remoteControlAgents.delete(id);
  inputBuffers.delete(id);
  const t = terminals.get(id); if (t) { try { t.kill(); } catch {} terminals.delete(id); setTimeout(() => { try { t.destroy(); } catch {} }, 2000); }
  agents.delete(id);
  send({ type: 'agentClosed', id });
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
    if (lines.some(l => l.trim())) { clrTimer(id, waitTimers); clrTimer(id, permTimers); if (a.permSent) { a.permSent = false; send({ type: 'permClear', id }); } }
    for (const line of lines) { if (line.trim()) parseLine(id, line); }
  } catch (e) { logToRenderer(`[readLines] Agent ${id} error: ${e.message} — file: ${a.jsonlFile}`); }
}

function parseLine(id, line) {
  const a = agents.get(id); if (!a) return;
  try {
    const r = JSON.parse(line);
    if (r.type === 'assistant') {
      // Extract usage/model regardless of content format (matches restore logic)
      if (r.message?.model) a.stats.modelFamily = modelFamily(r.message.model);
      const u = r.message?.usage;
      if (u) { a.stats.inTok += u.input_tokens || 0; a.stats.outTok += u.output_tokens || 0; a.stats.ctxTok = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0); a.stats.cacheTok += u.cache_creation_input_tokens || 0; a.stats.cacheRead += u.cache_read_input_tokens || 0; send({ type: 'stats', id, stats: a.stats }); }
    }
    if (r.type === 'assistant' && Array.isArray(r.message?.content)) {
      const blocks = r.message.content;
      for (const b of blocks) { if (b.type === 'text' && b.text) { a.lastText = b.text.length > PREVIEW_MAX ? b.text.slice(0, PREVIEW_MAX) + '\u2026' : b.text; send({ type: 'preview', id, text: a.lastText }); } }
      if (blocks.some(b => b.type === 'tool_use')) {
        clrTimer(id, waitTimers); a.isWaiting = false; a.hadTools = true;
        send({ type: 'status', id, status: 'active' });
        let nonExempt = false;
        for (const b of blocks) {
          if (b.type === 'tool_use' && b.id) {
            const tn = b.name || '', inp = b.input || {}, st = fmtTool(tn, inp);
            a.toolIds.add(b.id); a.toolStatuses.set(b.id, st); a.toolNames.set(b.id, tn); a.turnTools++;
            a.stats.tools[tn] = (a.stats.tools[tn] || 0) + 1;
            if (inp.file_path && ['Read', 'Write', 'Edit'].includes(tn)) a.stats.files++;
            if (!EXEMPT.has(tn)) nonExempt = true;
            detectRemoteControl(id, tn);
            if (tn === 'CronCreate') { a.cronCount++; send({ type: 'looping', id, active: true, count: a.cronCount }); }
            if (tn === 'CronDelete') { a.cronCount = Math.max(0, a.cronCount - 1); send({ type: 'looping', id, active: a.cronCount > 0, count: a.cronCount }); }
            send({ type: 'toolStart', id, toolId: b.id, status: st, name: tn });
          }
        }
        if (nonExempt) startPermTimer(id);
      } else if (blocks.some(b => b.type === 'text') && !a.hadTools) { startWaitTimer(id); }
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
          if (a.toolIds.size === 0) { a.hadTools = false; startWaitTimer(id); }
        } else {
          const txt = c.filter(b => b.type === 'text').map(b => b.text || '').join('').trim();
          if (txt) { setPrompt(id, a, txt); }
          clrTimer(id, waitTimers); clrActivity(id); a.hadTools = false; a.turnTools = 0;
        }
      } else if (typeof c === 'string' && c.trim()) {
        setPrompt(id, a, c);
        clrTimer(id, waitTimers); clrActivity(id); a.hadTools = false; a.turnTools = 0;
      }
    } else if (r.type === 'system' && r.subtype === 'compact_boundary') {
      // Context was compacted — reset ctxTok so bar reflects the reduction immediately
      // (next assistant message will set the real post-compact value)
      a.stats.ctxTok = 0;
      a.compacting = false;
      send({ type: 'stats', id, stats: a.stats });
      send({ type: 'compacting', id, active: false });
    } else if (r.type === 'system' && r.subtype === 'turn_duration') {
      clrTimer(id, waitTimers); clrTimer(id, permTimers);
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
      // New JSONL found — find the agent whose terminal is running and whose old JSONL stopped growing
      let targetId = null;
      for (const id of ids) {
        if (!terminals.has(id)) continue;
        const ag = agents.get(id);
        if (!ag) continue;
        // Prefer the agent whose old file matches the new session's dir
        // If only one terminal is running, that's the one that ran /clear
        targetId = id;
        break;
      }
      if (targetId !== null) {
        console.log(`[Overlord] New JSONL detected: ${path.basename(file)}, reassigning agent ${targetId}`);
        reassignAgentToFile(targetId, file);
      }
    }
  }
}

function reassignAgentToFile(id, newFilePath) {
  const a = agents.get(id); if (!a) return;
  // Stop old watchers
  const w = watchers.get(id); if (w) { try { w.close(); } catch {} watchers.delete(id); }
  const p = polls.get(id); if (p) { clearInterval(p); polls.delete(id); }
  try { fs.unwatchFile(a.jsonlFile); } catch {}
  // Clear activity
  clrTimer(id, waitTimers); clrTimer(id, permTimers);
  a.toolIds.clear(); a.toolStatuses.clear(); a.toolNames.clear();
  a.subToolIds.clear(); a.subToolNames.clear();
  a.isWaiting = false; a.permSent = false; a.hadTools = false; a.turnTools = 0;
  send({ type: 'toolsClear', id });
  // Reset stats (new session = fresh context)
  const oldModel = a.stats.modelFamily;
  a.stats = { inTok: 0, outTok: 0, cacheTok: 0, cacheRead: 0, ctxTok: 0, turns: 0, durMs: 0, tools: {}, files: 0, modelFamily: oldModel };
  send({ type: 'stats', id, stats: a.stats });
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
function startWaitTimer(id) { clrTimer(id, waitTimers); waitTimers.set(id, setTimeout(() => { waitTimers.delete(id); const a = agents.get(id); if (!a) return; a.isWaiting = true; send({ type: 'status', id, status: 'waiting' }); }, TEXT_IDLE_DELAY_MS)); }
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
    const n = new Notification({ title: 'Needs approval', body: `${title}${toolName ? ': ' + toolName : ''}`, silent: false });
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

function resumeSessionAgent(sid, rcwd) {
  const rjsonl = path.join(claudeDir(rcwd), `${sid}.jsonl`);
  const rid = nextId++;
  const ra = {
    id: rid, sessionId: sid, cwd: rcwd, jsonlFile: rjsonl,
    fileOffset: 0, lineBuffer: '',
    toolIds: new Set(), toolStatuses: new Map(), toolNames: new Map(),
    subToolIds: new Map(), subToolNames: new Map(),
    isWaiting: false, permSent: false, hadTools: false, turnTools: 0,
    lastText: '', lastPrompt: '', title: '', agentName: null,
    promptHistory: [], titlePending: false, createdAt: Date.now(), cronCount: 0, compacting: false,
    stats: { inTok: 0, outTok: 0, cacheTok: 0, cacheRead: 0, ctxTok: 0, turns: 0, durMs: 0, tools: {}, files: 0, modelFamily: 'sonnet' },
  };
  agents.set(rid, ra);
  ra.agentName = pickAgentName(); // assign after agents.set so dedup works
  if (fs.existsSync(rjsonl)) {
    try {
      const content = fs.readFileSync(rjsonl, 'utf-8');
      for (const line of content.split('\n').filter(l => l.trim())) {
        try {
          const r = JSON.parse(line);
          if (r.type === 'assistant' && r.message?.usage) {
            if (r.message.model) ra.stats.modelFamily = modelFamily(r.message.model);
            const u = r.message.usage;
            ra.stats.inTok += u.input_tokens || 0; ra.stats.outTok += u.output_tokens || 0;
            ra.stats.ctxTok = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
            ra.stats.cacheTok += u.cache_creation_input_tokens || 0; ra.stats.cacheRead += u.cache_read_input_tokens || 0;
          }
          if (r.type === 'assistant' && Array.isArray(r.message?.content)) {
            for (const b of r.message.content) {
              if (b.type === 'text' && b.text) ra.lastText = b.text.length > PREVIEW_MAX ? b.text.slice(0, PREVIEW_MAX) + '\u2026' : b.text;
              if (b.type === 'tool_use' && b.name) {
                ra.stats.tools[b.name] = (ra.stats.tools[b.name] || 0) + 1;
                detectRemoteControl(rid, b.name);
                if (b.name === 'CronCreate') ra.cronCount++;
                if (b.name === 'CronDelete') ra.cronCount = Math.max(0, ra.cronCount - 1);
              }
            }
          }
          if (r.type === 'user') {
            const c = r.message?.content;
            let p = '';
            if (typeof c === 'string' && c.trim()) p = c;
            else if (Array.isArray(c)) p = c.filter(b => b.type === 'text').map(b => b.text || '').join('').trim();
            if (p) {
              ra.lastPrompt = p.length > PREVIEW_MAX ? p.slice(0, PREVIEW_MAX) + '\u2026' : p;
              if (!ra.title) ra.title = deriveTitle(p);
              const brief = p.length > PROMPT_BRIEF_MAX ? p.slice(0, PROMPT_BRIEF_MAX) : p;
              ra.promptHistory.push(brief); if (ra.promptHistory.length > PROMPT_HISTORY_MAX) ra.promptHistory.shift();
            }
          }
          if (r.type === 'system' && r.subtype === 'compact_boundary') { ra.stats.ctxTok = 0; }
          if (r.type === 'system' && r.subtype === 'turn_duration') { ra.stats.turns++; ra.stats.durMs += r.durationMs || 0; }
        } catch {}
      }
      ra.fileOffset = fs.statSync(rjsonl).size;
    } catch {}
  }
  registerKnownJsonl(claudeDir(rcwd), rjsonl);
  send({ type: 'agentCreated', id: rid, cwd: rcwd, sessionId: sid, title: ra.title, createdAt: ra.createdAt, agentName: ra.agentName });
  if (ra.lastPrompt) send({ type: 'prompt', id: rid, text: ra.lastPrompt });
  if (ra.promptHistory.length) send({ type: 'promptHistory', id: rid, prompts: [...ra.promptHistory] });
  if (ra.lastText) send({ type: 'preview', id: rid, text: ra.lastText });
  if (ra.title) send({ type: 'title', id: rid, text: ra.title });
  send({ type: 'stats', id: rid, stats: ra.stats });
  send({ type: 'status', id: rid, status: 'waiting' });
  saveState();
  spawnTerminal(rid);
  send({ type: 'focusFromNotification', id: rid });
}

// ── Usage polling ─────────────────────────────────────
let usageInFlight = false;
let lastUsage = null;

function fetchUsage() {
  if (usageInFlight) return;
  fetchUsageHeadless();
}

function fetchUsageHeadless() {
  usageInFlight = true;
  const sh = process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL || 'bash');
  const args = process.platform === 'win32' ? ['/c', 'claude'] : ['-c', 'claude'];
  let proc;
  try {
    proc = pty.spawn(sh, args, { name: 'xterm-256color', cols: 120, rows: 30, cwd: os.homedir(), env: { ...process.env } });
  } catch (e) {
    console.log('[Overlord] Usage spawn failed:', e.message);
    usageInFlight = false;
    return;
  }
  let buf = '';
  let sentUsage = false;
  let sentExit = false;
  let parsed = false;
  function finish() {
    if (parsed) return;
    parsed = true;
    usageInFlight = false;
    parseAndSendUsage(buf);
  }
  proc.onData((d) => {
    buf += d;
    if (!sentUsage && buf.length > 100) {
      sentUsage = true;
      setTimeout(() => {
        try { proc.write('/usage\r'); } catch {}
        setTimeout(() => {
          if (!sentExit) { sentExit = true; try { proc.write('/exit\r'); } catch {} }
        }, 3000);
      }, 500);
    }
  });
  const timeout = setTimeout(() => {
    finish();
    if (!sentExit) { sentExit = true; try { proc.write('/exit\r'); } catch {} }
    setTimeout(() => { try { proc.kill(); } catch {} }, 2000);
  }, USAGE_TIMEOUT_MS);
  proc.onExit(() => {
    clearTimeout(timeout);
    finish();
  });
}

function parseAndSendUsage(raw) {
  // Strip ANSI escape sequences
  const clean = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
  const usage = {};
  const lines = clean.split(/[\r\n]+/);
  for (const line of lines) {
    const lower = line.toLowerCase();
    const pctMatch = line.match(/([\d.]+)\s*%/);
    if (!pctMatch) continue;
    const pct = parseFloat(pctMatch[1]);
    if (isNaN(pct)) continue;
    if (lower.includes('hourly') || lower.includes('hour') || lower.includes('5m') || lower.includes('5 min')) {
      usage.hourly = pct;
    } else if (lower.includes('daily') || lower.includes('day')) {
      usage.daily = pct;
    } else if (lower.includes('weekly') || lower.includes('week')) {
      if (!usage.weekly) usage.weekly = pct;
      else usage.weeklyModel = pct;
    } else if (lower.includes('session')) {
      usage.session = pct;
    }
  }
  if (Object.keys(usage).length > 0) {
    lastUsage = usage;
    send({ type: 'usage', usage });
  }
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

function handleTermInput(id, data) {
  const t = terminals.get(id);
  if (!t) return;
  let buf = inputBuffers.get(id) || '';

  // Multi-char paste or chunk containing Enter
  if (data.length > 1 && data.includes('\r')) {
    // Treat entire paste as one input; combine with existing buffer
    const full = buf + data;
    const lastCR = full.lastIndexOf('\r');
    const toSend = full.slice(0, lastCR); // everything up to last Enter
    const remainder = full.slice(lastCR + 1);
    const mentions = findMentions(toSend);
    if (mentions.length > 0) {
      const ctx = buildMentionContext(mentions);
      // Clear existing line with Ctrl+U, then rewrite with context
      t.write('\x15');
      t.write(toSend + '\n\n' + ctx + '\r');
    } else {
      t.write(data);
    }
    inputBuffers.set(id, remainder);
    return;
  }

  // Single-char handling
  if (data === '\r') {
    // Enter pressed — check buffer for mentions
    const mentions = findMentions(buf);
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

// ── IPC ────────────────────────────────────────────────
ipcMain.on('cmd', (_e, msg) => {
  switch (msg.type) {
    case 'createAgent': createAgent(msg.cwd, msg.prompt); break;
    case 'closeAgent': closeAgent(msg.id); break;
    case 'renameAgent': { const a = agents.get(msg.id); if (a) { a.title = msg.name; a.customName = true; send({ type: 'title', id: msg.id, text: msg.name, customName: true }); saveState(); } break; }
    case 'clearCustomName': { const a = agents.get(msg.id); if (a) { a.customName = false; send({ type: 'title', id: msg.id, text: a.title, customName: false }); saveState(); generateSummaryTitle(msg.id); } break; }
    case 'restartAgent': {
      const a = agents.get(msg.id);
      if (a) {
        const c = a.cwd;
        const savedTitle = a.customName ? a.title : '';
        const savedCustomName = a.customName;
        const savedAgentName = a.agentName;
        closeAgent(msg.id);
        const newId = createAgent(c);
        const na = agents.get(newId);
        if (na && savedAgentName) { na.agentName = savedAgentName; send({ type: 'agentNameChanged', id: newId, agentName: savedAgentName }); }
        if (savedCustomName && savedTitle) {
          if (na) { na.title = savedTitle; na.customName = true; }
          send({ type: 'title', id: newId, text: savedTitle, customName: true });
          saveState();
        }
        send({ type: 'focusFromNotification', id: newId });
      }
      break;
    }
    case 'focusAgent': spawnTerminal(msg.id); send({ type: 'focused', id: msg.id }); break;
    case 'termInput': handleTermInput(msg.id, msg.data); break;
    case 'enableRemoteControl': { const t = terminals.get(msg.id); if (t) t.write('/remote-control\r'); break; }
    case 'stopLoop': { const a = agents.get(msg.id); if (a) { a.cronCount = 0; send({ type: 'looping', id: msg.id, active: false, count: 0 }); } const t = terminals.get(msg.id); if (t) t.write('\x03'); break; }
    case 'compactAgent': { const a = agents.get(msg.id); const t = terminals.get(msg.id); if (a && t && a.isWaiting) { a.compacting = true; send({ type: 'compacting', id: msg.id, active: true }); t.write('/compact\r'); } break; }
    case 'termResize': { const t = terminals.get(msg.id); if (t) try { t.resize(msg.cols, msg.rows); } catch {} break; }
    case 'browseFolder':
      dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: 'Select Project Folder' })
        .then(r => { if (!r.canceled && r.filePaths[0]) send({ type: 'folderSelected', path: r.filePaths[0] }); });
      break;
    case 'openUrl': { const url = msg.url; if (typeof url === 'string' && /^(?:https?|file):\/\//.test(url)) shell.openExternal(url).catch(() => {}); break; }
    case 'killServer': {
      const port = msg.port;
      if (typeof port !== 'number' || port < 1024 || port > 65535) break;
      try {
        if (process.platform === 'win32') {
          // Find PID listening on the port and kill it
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
    case 'openFolder': { const p = msg.path; if (typeof p === 'string' && fs.existsSync(p)) shell.openPath(p).catch(() => {}); break; }
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
      // Try VS Code with --goto for line:col support
      const goto = line ? `${p}:${line}${col ? ':' + col : ''}` : p;
      try {
        spawn('code', ['--goto', goto], { detached: true, stdio: 'ignore' }).unref();
      } catch {
        shell.openPath(p).catch(() => {});
      }
      break;
    }
    case 'pasteImage': {
      const img = clipboard.readImage();
      if (img.isEmpty()) break;
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
    case 'exportTranscript': exportTranscript(msg.id).catch(e => console.log('[Overlord] Export failed:', e.message)); break;
    case 'saveSettings': Object.assign(settings, msg.settings); saveState(); break;
    case 'relaunch': app.relaunch(); app.exit(0); break;
    case 'getTimeline': { const evts = getFullTimeline(msg.id); send({ type: 'timelineData', id: msg.id, events: evts }); break; }
    case 'globalSearch': { const results = globalSearch(msg.query); send({ type: 'searchResults', query: msg.query, results }); break; }
    case 'setTimelineAgent': timelineAgentId = msg.id ?? null; break;
    case 'getSessions': scanSessions().then(s => send({ type: 'sessions', sessions: s })).catch(() => send({ type: 'sessions', sessions: [] })); break;
    case 'resumeSession': resumeSessionAgent(msg.sessionId, msg.cwd); break;
    case 'fetchUsage': fetchUsage(); break;
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
});

// Periodically push stats + scan for new JSONL files (/clear detection)
setInterval(() => {
  for (const [id, a] of agents) send({ type: 'stats', id, stats: a.stats });
  scanForNewJsonlFiles();
}, 5000);

// Periodically scan for teams
setInterval(() => scanTeams(), TEAM_POLL_MS);

// Periodically fetch usage
setInterval(() => fetchUsage(), USAGE_POLL_MS);

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
  if (settings.isMaximized) mainWindow.maximize();
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.setMenuBarVisibility(false);
  // Show window as soon as the page is painted — don't wait for agent restoration
  mainWindow.once('ready-to-show', () => mainWindow.show());
  // Restore agents after window is visible (heavy JSONL parsing + process cleanup)
  mainWindow.webContents.once('did-finish-load', () => {
    restoreAgents(state);
    sendFullState();
  });
  mainWindow.on('focus', () => mainWindow.flashFrame(false));
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
});
app.on('before-quit', () => {
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
      const child = spawn(sh, args, { cwd: a.cwd, detached: true, stdio: 'ignore', env: { ...process.env } });
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
