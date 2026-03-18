const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const pty = require('node-pty');

// ── Constants ──────────────────────────────────────────
const JSONL_POLL_MS = 1000;
const TOOL_DONE_DELAY_MS = 300;
const PERMISSION_TIMER_MS = 7000;
const TEXT_IDLE_DELAY_MS = 5000;
const PREVIEW_MAX = 200;
const PROMPT_HISTORY_MAX = 5;
const PROMPT_BRIEF_MAX = 150;
const TITLE_MODEL = 'claude-haiku-4-5-20251001';
const TITLE_REGEN_TURNS = 3;
const EXEMPT = new Set(['Task', 'Agent', 'AskUserQuestion']);
const MAX_CRASH_RETRIES = 3;
const CRASH_RESUME_DELAY_MS = 2000;

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
let nextId = 1;

function send(data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('msg', data);
}

function claudeDir(projectPath) {
  return path.join(os.homedir(), '.claude', 'projects', projectPath.replace(/[:\\/]/g, '-'));
}

function deriveTitle(text) {
  const clean = text.replace(/[\n\r]+/g, ' ').trim();
  const words = clean.split(/\s+/).slice(0, 5).join(' ');
  return words.length > 40 ? words.slice(0, 40) + '\u2026' : words;
}

async function generateSummaryTitle(id) {
  const a = agents.get(id);
  if (!a || !a.promptHistory || a.promptHistory.length === 0 || a.titlePending) return;
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
  if (!a.title) {
    a.title = deriveTitle(text);
    send({ type: 'title', id, text: a.title });
    saveState();
  }
  send({ type: 'prompt', id, text: a.lastPrompt });
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
  for (const [, a] of agents) {
    const wasActive = !a.isWaiting;
    let jsonlSize = 0;
    try { jsonlSize = fs.statSync(a.jsonlFile).size; } catch {}
    agentEntries.push({ cwd: a.cwd, sessionId: a.sessionId, lastPrompt: a.lastPrompt, lastText: a.lastText, title: a.title, createdAt: a.createdAt, wasActive, jsonlSize });
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

function restoreAgents() {
  const state = loadState();
  settings = { ...settings, ...state.settings };
  const saved = state.agents;
  if (saved.length === 0) return;
  for (const entry of saved) {
    const { cwd, sessionId, lastPrompt, lastText, title, createdAt, wasActive, jsonlSize } = entry;
    if (!cwd || !sessionId) continue; // skip corrupted entries
    const jsonlFile = path.join(claudeDir(cwd), `${sessionId}.jsonl`);

    // Detect if orphaned Claude process is still running (JSONL grew since shutdown)
    let orphanAlive = false;
    if (wasActive && jsonlSize) {
      try { orphanAlive = fs.statSync(jsonlFile).size > jsonlSize; } catch {}
    }

    const id = nextId++;
    const agent = {
      id, sessionId, cwd, jsonlFile,
      fileOffset: 0, lineBuffer: '',
      toolIds: new Set(), toolStatuses: new Map(), toolNames: new Map(),
      subToolIds: new Map(), subToolNames: new Map(),
      isWaiting: !orphanAlive, permSent: false, hadTools: orphanAlive, turnTools: 0,
      lastText: lastText || '', lastPrompt: lastPrompt || '', title: title || '',
      promptHistory: [], titlePending: false, createdAt: createdAt || Date.now(),
      crashCount: 0, orphanAlive,
      stats: { inTok: 0, outTok: 0, cacheTok: 0, cacheRead: 0, ctxTok: 0, turns: 0, durMs: 0, tools: {}, files: 0, modelFamily: 'sonnet' },
    };
    agents.set(id, agent);

    // If JSONL exists, read it to rebuild stats
    if (fs.existsSync(jsonlFile)) {
      try {
        const content = fs.readFileSync(jsonlFile, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim());
        for (const line of lines) {
          try {
            const r = JSON.parse(line);
            if (r.type === 'assistant' && r.message?.usage) {
              if (r.message.model) agent.stats.modelFamily = modelFamily(r.message.model);
              const u = r.message.usage;
              agent.stats.inTok += u.input_tokens || 0;
              agent.stats.outTok += u.output_tokens || 0;
              if (u.input_tokens) agent.stats.ctxTok = u.input_tokens;
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
                if (!agent.title) agent.title = deriveTitle(pTxt);
                const brief = pTxt.length > PROMPT_BRIEF_MAX ? pTxt.slice(0, PROMPT_BRIEF_MAX) : pTxt;
                agent.promptHistory.push(brief);
                if (agent.promptHistory.length > PROMPT_HISTORY_MAX) agent.promptHistory.shift();
              }
            }
            if (r.type === 'system' && r.subtype === 'turn_duration') {
              agent.stats.turns++;
              agent.stats.durMs += r.durationMs || 0;
            }
          } catch {}
        }
        agent.fileOffset = fs.statSync(jsonlFile).size;
      } catch {}
    }

    // Don't spawn terminal yet — it'll be spawned on click (lazy)
    // If orphan is alive, set a timeout to clear the flag if no turn_duration arrives
    if (orphanAlive) {
      const savedSize = agent.fileOffset;
      setTimeout(() => {
        if (!agent.orphanAlive) return; // already cleared by turn_duration
        // Check if JSONL actually grew since restore — if not, orphan is dead
        try {
          const curSize = fs.statSync(jsonlFile).size;
          if (curSize <= savedSize) {
            agent.orphanAlive = false;
            agent.isWaiting = true;
            console.log(`[Overlord] Orphan for agent ${id} appears dead (no JSONL growth) — clearing flag`);
            send({ type: 'status', id, status: 'waiting' });
          }
        } catch {
          agent.orphanAlive = false;
          agent.isWaiting = true;
          send({ type: 'status', id, status: 'waiting' });
        }
      }, 15000);
    }
    console.log(`[Overlord] Restored agent ${id}: session=${sessionId} cwd=${cwd}${orphanAlive ? ' (orphan still running)' : ''}`);
  }
}

function handleTermExit(id, exitCode) {
  const a = agents.get(id);
  if (!a) return;
  terminals.delete(id);
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

  const hasJsonl = fs.existsSync(a.jsonlFile);
  const skip = settings.bypassPermissions ? ' --dangerously-skip-permissions' : '';
  const claudeCmd = hasJsonl ? `claude --resume ${a.sessionId}${skip}` : `claude --session-id ${a.sessionId}${skip}`;
  const sh = process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL || 'bash');
  const args = process.platform === 'win32' ? `/k ${claudeCmd}` : ['-c', claudeCmd];
  try {
    const proc = pty.spawn(sh, args, { name: 'xterm-256color', cols: 120, rows: 30, cwd: a.cwd, env: { ...process.env } });
    terminals.set(id, proc);
    proc.onData((d) => { try { send({ type: 'termData', id, data: d }); } catch {} });
    proc.onExit((e) => handleTermExit(id, e?.exitCode));
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
    lastText: '', lastPrompt: '', title: '',
    promptHistory: [], titlePending: false, createdAt: Date.now(),
    crashCount: 0,
    stats: { inTok: 0, outTok: 0, cacheTok: 0, cacheRead: 0, ctxTok: 0, turns: 0, durMs: 0, tools: {}, files: 0, modelFamily: 'sonnet' },
  };
  agents.set(id, agent);

  const skip = settings.bypassPermissions ? ' --dangerously-skip-permissions' : '';
  let promptArg = '';
  if (initialPrompt) {
    if (process.platform === 'win32') {
      // cmd.exe double-quoted: "" escapes quotes, %% prevents env var expansion
      // &|<>^ are already literal inside double quotes so no escaping needed
      const escaped = initialPrompt.replace(/%/g, '%%').replace(/"/g, '""');
      promptArg = ` "${escaped}"`;
    } else {
      // bash/zsh: single-quote, escape inner single-quotes
      const escaped = initialPrompt.replace(/'/g, "'\\''");
      promptArg = ` '${escaped}'`;
    }
  }
  const claudeCmd = `claude --session-id ${sessionId}${skip}${promptArg}`;
  const shell = process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL || 'bash');
  const shellArgs = process.platform === 'win32' ? `/k ${claudeCmd}` : ['-c', claudeCmd];
  send({ type: 'agentCreated', id, cwd, sessionId, createdAt: agent.createdAt });

  try {
    const proc = pty.spawn(shell, shellArgs, { name: 'xterm-256color', cols: 120, rows: 30, cwd, env: { ...process.env } });
    terminals.set(id, proc);
    proc.onData((d) => { try { send({ type: 'termData', id, data: d }); } catch {} });
    proc.onExit((e) => handleTermExit(id, e?.exitCode));
  } catch (e) {
    console.log(`[Overlord] Failed to spawn agent ${id}:`, e.message);
    send({ type: 'termData', id, data: `\r\n\x1b[31mFailed to start: ${e.message}\x1b[0m\r\n` });
  }
  saveState();

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
  const t = terminals.get(id); if (t) { try { t.kill(); } catch {} try { t.destroy(); } catch {} terminals.delete(id); }
  agents.delete(id);
  send({ type: 'agentClosed', id });
  saveState();
}

// ── JSONL watching ─────────────────────────────────────
function startWatch(id) {
  const a = agents.get(id); if (!a) return;
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
    if (st.size <= a.fileOffset) return;
    const buf = Buffer.alloc(st.size - a.fileOffset);
    const fd = fs.openSync(a.jsonlFile, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, a.fileOffset); } finally { fs.closeSync(fd); }
    a.fileOffset = st.size;
    const text = a.lineBuffer + buf.toString('utf-8');
    const lines = text.split('\n'); a.lineBuffer = lines.pop() || '';
    if (lines.some(l => l.trim())) { clrTimer(id, waitTimers); clrTimer(id, permTimers); if (a.permSent) { a.permSent = false; send({ type: 'permClear', id }); } }
    for (const line of lines) { if (line.trim()) parseLine(id, line); }
  } catch {}
}

function parseLine(id, line) {
  const a = agents.get(id); if (!a) return;
  try {
    const r = JSON.parse(line);
    if (r.type === 'assistant') {
      // Extract usage/model regardless of content format (matches restore logic)
      if (r.message?.model) a.stats.modelFamily = modelFamily(r.message.model);
      const u = r.message?.usage;
      if (u) { a.stats.inTok += u.input_tokens || 0; a.stats.outTok += u.output_tokens || 0; if (u.input_tokens) a.stats.ctxTok = u.input_tokens; a.stats.cacheTok += u.cache_creation_input_tokens || 0; a.stats.cacheRead += u.cache_read_input_tokens || 0; }
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
              if (cn === 'Task' || cn === 'Agent') { a.subToolIds.delete(tid); a.subToolNames.delete(tid); }
              a.toolIds.delete(tid); a.toolStatuses.delete(tid); a.toolNames.delete(tid);
              setTimeout(() => send({ type: 'toolDone', id, toolId: tid }), TOOL_DONE_DELAY_MS);
            }
          }
          if (a.toolIds.size === 0) a.hadTools = false;
        } else {
          const txt = c.filter(b => b.type === 'text').map(b => b.text || '').join('').trim();
          if (txt) { setPrompt(id, a, txt); }
          clrTimer(id, waitTimers); clrActivity(id); a.hadTools = false; a.turnTools = 0;
        }
      } else if (typeof c === 'string' && c.trim()) {
        setPrompt(id, a, c);
        clrTimer(id, waitTimers); clrActivity(id); a.hadTools = false; a.turnTools = 0;
      }
    } else if (r.type === 'system' && r.subtype === 'turn_duration') {
      clrTimer(id, waitTimers); clrTimer(id, permTimers);
      a.stats.turns++; a.stats.durMs += r.durationMs || 0;
      if (a.toolIds.size > 0) { a.toolIds.clear(); a.toolStatuses.clear(); a.toolNames.clear(); a.subToolIds.clear(); a.subToolNames.clear(); send({ type: 'toolsClear', id }); }
      a.isWaiting = true; a.permSent = false; a.hadTools = false; a.turnTools = 0; a.crashCount = 0;
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
        if (d.type === 'bash_progress' || d.type === 'mcp_progress') { if (a.toolIds.has(ptid)) startPermTimer(id); }
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

// ── Timers ─────────────────────────────────────────────
function clrTimer(id, map) { const t = map.get(id); if (t) { clearTimeout(t); map.delete(id); } }
function clrActivity(id) { const a = agents.get(id); if (!a) return; a.toolIds.clear(); a.toolStatuses.clear(); a.toolNames.clear(); a.subToolIds.clear(); a.subToolNames.clear(); a.isWaiting = false; a.permSent = false; clrTimer(id, permTimers); send({ type: 'toolsClear', id }); send({ type: 'status', id, status: 'active' }); }
function startWaitTimer(id) { clrTimer(id, waitTimers); waitTimers.set(id, setTimeout(() => { waitTimers.delete(id); const a = agents.get(id); if (!a) return; a.isWaiting = true; send({ type: 'status', id, status: 'waiting' }); }, TEXT_IDLE_DELAY_MS)); }
function startPermTimer(id) { clrTimer(id, permTimers); permTimers.set(id, setTimeout(() => { permTimers.delete(id); const a = agents.get(id); if (!a) return; let ne = false; for (const tid of a.toolIds) { if (!EXEMPT.has(a.toolNames.get(tid) || '')) { ne = true; break; } } if (ne) { a.permSent = true; send({ type: 'perm', id }); notifyPermission(id, a); } }, PERMISSION_TIMER_MS)); }

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
    lastText: '', lastPrompt: '', title: '',
    promptHistory: [], titlePending: false, createdAt: Date.now(),
    stats: { inTok: 0, outTok: 0, cacheTok: 0, cacheRead: 0, ctxTok: 0, turns: 0, durMs: 0, tools: {}, files: 0, modelFamily: 'sonnet' },
  };
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
            if (u.input_tokens) ra.stats.ctxTok = u.input_tokens;
            ra.stats.cacheTok += u.cache_creation_input_tokens || 0; ra.stats.cacheRead += u.cache_read_input_tokens || 0;
          }
          if (r.type === 'assistant' && Array.isArray(r.message?.content)) {
            for (const b of r.message.content) {
              if (b.type === 'text' && b.text) ra.lastText = b.text.length > PREVIEW_MAX ? b.text.slice(0, PREVIEW_MAX) + '\u2026' : b.text;
              if (b.type === 'tool_use' && b.name) ra.stats.tools[b.name] = (ra.stats.tools[b.name] || 0) + 1;
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
          if (r.type === 'system' && r.subtype === 'turn_duration') { ra.stats.turns++; ra.stats.durMs += r.durationMs || 0; }
        } catch {}
      }
      ra.fileOffset = fs.statSync(rjsonl).size;
    } catch {}
  }
  agents.set(rid, ra);
  send({ type: 'agentCreated', id: rid, cwd: rcwd, sessionId: sid, title: ra.title, createdAt: ra.createdAt });
  if (ra.lastPrompt) send({ type: 'prompt', id: rid, text: ra.lastPrompt });
  if (ra.lastText) send({ type: 'preview', id: rid, text: ra.lastText });
  if (ra.title) send({ type: 'title', id: rid, text: ra.title });
  send({ type: 'stats', id: rid, stats: ra.stats });
  send({ type: 'status', id: rid, status: 'waiting' });
  saveState();
  spawnTerminal(rid);
  send({ type: 'focusFromNotification', id: rid });
}

// ── IPC ────────────────────────────────────────────────
ipcMain.on('cmd', (_e, msg) => {
  switch (msg.type) {
    case 'createAgent': createAgent(msg.cwd, msg.prompt); break;
    case 'closeAgent': closeAgent(msg.id); break;
    case 'restartAgent': { const a = agents.get(msg.id); if (a) { const c = a.cwd; closeAgent(msg.id); const newId = createAgent(c); send({ type: 'focusFromNotification', id: newId }); } break; }
    case 'focusAgent': spawnTerminal(msg.id); send({ type: 'focused', id: msg.id }); break;
    case 'termInput': { const t = terminals.get(msg.id); if (t) t.write(msg.data); break; }
    case 'termResize': { const t = terminals.get(msg.id); if (t) try { t.resize(msg.cols, msg.rows); } catch {} break; }
    case 'browseFolder':
      dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: 'Select Project Folder' })
        .then(r => { if (!r.canceled && r.filePaths[0]) send({ type: 'folderSelected', path: r.filePaths[0] }); });
      break;
    case 'openUrl': { const url = msg.url; if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url).catch(() => {}); break; }
    case 'openFolder': { const p = msg.path; if (typeof p === 'string' && fs.existsSync(p)) shell.openPath(p).catch(() => {}); break; }
    case 'exportTranscript': exportTranscript(msg.id).catch(e => console.log('[Overlord] Export failed:', e.message)); break;
    case 'saveSettings': Object.assign(settings, msg.settings); saveState(); break;
    case 'relaunch': app.relaunch(); app.exit(0); break;
    case 'getTimeline': { const evts = getFullTimeline(msg.id); send({ type: 'timelineData', id: msg.id, events: evts }); break; }
    case 'setTimelineAgent': timelineAgentId = msg.id ?? null; break;
    case 'getSessions': scanSessions().then(s => send({ type: 'sessions', sessions: s })).catch(() => send({ type: 'sessions', sessions: [] })); break;
    case 'resumeSession': resumeSessionAgent(msg.sessionId, msg.cwd); break;
    case 'getAgents': {
      // Send settings first
      send({ type: 'settings', settings });
      // Send current state snapshot + start watching JSONL for live updates
      for (const [id, a] of agents) {
        send({ type: 'agentCreated', id, cwd: a.cwd, sessionId: a.sessionId, title: a.title, createdAt: a.createdAt });
        if (a.lastPrompt) send({ type: 'prompt', id, text: a.lastPrompt });
        if (a.lastText) send({ type: 'preview', id, text: a.lastText });
        if (a.title) send({ type: 'title', id, text: a.title });
        if (a.isWaiting) send({ type: 'status', id, status: 'waiting' });
        else send({ type: 'status', id, status: 'active' });
        for (const [tid, st] of a.toolStatuses) {
          send({ type: 'toolStart', id, toolId: tid, status: st, name: a.toolNames.get(tid) });
          const subs = a.subToolIds.get(tid);
          const names = a.subToolNames.get(tid);
          if (subs && names) { for (const stid of subs) { const sn = names.get(stid) || ''; send({ type: 'subToolStart', id, parentToolId: tid, toolId: stid, status: fmtTool(sn, {}), name: sn }); } }
        }
        send({ type: 'stats', id, stats: a.stats });
        // Start JSONL watching for restored agents (terminal is still lazy-spawned on click)
        if (fs.existsSync(a.jsonlFile) && !watchers.has(id) && !polls.has(id)) startWatch(id);
      }
      break;
    }
  }
});

// Periodically push stats
setInterval(() => {
  for (const [id, a] of agents) send({ type: 'stats', id, stats: a.stats });
}, 5000);

// ── Window ─────────────────────────────────────────────
let _boundsTimer = null;
function saveWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
  settings.windowBounds = mainWindow.getBounds();
  clearTimeout(_boundsTimer);
  _boundsTimer = setTimeout(() => saveState(), 500);
}

app.whenReady().then(() => {
  restoreAgents();
  const bounds = settings.windowBounds || {};
  const opts = {
    width: bounds.width || 750, height: bounds.height || 800,
    minWidth: 500, minHeight: 400,
    title: 'Overlord',
    backgroundColor: '#1e1e2e',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  };
  if (bounds.x !== undefined && bounds.y !== undefined) { opts.x = bounds.x; opts.y = bounds.y; }
  mainWindow = new BrowserWindow(opts);
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.setMenuBarVisibility(false);
  mainWindow.on('focus', () => mainWindow.flashFrame(false));
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.key === 'F5' && input.type === 'keyDown') { app.relaunch(); app.exit(0); }
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
  // detects it via JSONL growth and waits for it to finish before reconnecting.
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
      console.log(`[Overlord] Spawned detached Claude for agent ${id} (session ${a.sessionId})`);
    } catch (e) {
      console.log(`[Overlord] Failed to spawn detached Claude for agent ${id}:`, e.message);
    }
  }
});
app.on('window-all-closed', () => app.quit());
