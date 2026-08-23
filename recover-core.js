// Rebuild the agent list from Claude's own transcripts when Overlord's state file
// is gone. Claude writes one .jsonl per session under ~/.claude/projects/<slug>/ and
// every record carries the real cwd, so the list is recoverable without us.
// Self-check: recover-core.test.js

const fs = require('fs');
const path = require('path');

// Only the head of the file is needed: cwd is on every record and the first user
// prompt makes a usable title. Tail-reading a 79MB transcript buys nothing.
function readHead(file, bytes = 262144) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(bytes, fs.fstatSync(fd).size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}

function scanTranscript(file) {
  let cwd = null, prompt = null;
  for (const line of readHead(file).split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; } // a truncated last line is normal
    if (!cwd && r.cwd) cwd = r.cwd;
    if (!prompt && r.type === 'user') {
      const c = r.message && r.message.content;
      const t = typeof c === 'string' ? c
        : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text || '').join('') : '';
      if (t.trim() && !t.startsWith('<') && !t.startsWith('Caveat:')) prompt = t.trim();
    }
    if (cwd && prompt) break;
  }
  return { cwd, prompt };
}

// Sessions touched in the last `days`, newest-created last, one entry per session.
function scanSessions(projectsDir, days = 2, now = Date.now()) {
  const cutoff = now - days * 86400e3;
  const found = [];
  let dirs; try { dirs = fs.readdirSync(projectsDir); } catch { return []; }
  for (const dir of dirs) {
    const full = path.join(projectsDir, dir);
    let files; try { files = fs.readdirSync(full); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(full, f);
      let st; try { st = fs.statSync(file); } catch { continue; }
      if (st.mtimeMs < cutoff || st.size === 0) continue;
      let scanned; try { scanned = scanTranscript(file); } catch { continue; }
      if (!scanned.cwd) continue;
      found.push({
        cwd: scanned.cwd,
        sessionId: path.basename(f, '.jsonl'),
        lastPrompt: '', lastText: '',
        title: (scanned.prompt || '').split('\n')[0].slice(0, 60),
        customName: false,
        createdAt: st.birthtimeMs || st.mtimeMs,
        wasActive: false, jsonlSize: st.size, pid: null,
        agentName: null, promptHistory: [], cronCount: 0,
        // Zeroed rather than absent on purpose: restoreAgents() re-parses the whole
        // transcript when stats are missing, and some of these are 79MB.
        stats: { inTok: 0, outTok: 0, cacheTok: 0, cacheRead: 0, ctxTok: 0, turns: 0, durMs: 0, tools: {}, files: 0, modelFamily: 'sonnet' },
        // Archived so a recovery can't flood the UI or pre-warm 70 `claude --resume`
        // processes at boot. Unarchiving is one click.
        archived: true,
      });
    }
  }
  // A resumed session is written under both the worktree's project dir and the
  // parent repo's; keep the bigger transcript so the agent isn't listed twice.
  const bySession = new Map();
  for (const a of found) {
    const prev = bySession.get(a.sessionId);
    if (!prev || a.jsonlSize > prev.jsonlSize) bySession.set(a.sessionId, a);
  }
  return [...bySession.values()].sort((a, b) => a.createdAt - b.createdAt);
}

// Merge recovered sessions into a state blob. Existing agents always win; projects
// and bookmarks are re-derived from the cwds because they lived in the same lost
// settings blob. Returns how many agents were added.
function mergeRecovered(state, sessions) {
  if (!Array.isArray(state.agents)) state.agents = [];
  if (!state.settings || typeof state.settings !== 'object') state.settings = {};
  const have = new Set(state.agents.map(a => a.sessionId));
  const added = sessions.filter(a => !have.has(a.sessionId));
  state.agents.push(...added);

  const projects = new Set(state.settings.knownProjects || []);
  for (const a of state.agents) if (a.cwd) projects.add(a.cwd);
  state.settings.knownProjects = [...projects];

  state.settings.bookmarks = state.settings.bookmarks || [];
  for (const p of projects) {
    if (state.settings.bookmarks.some(b => b.path === p)) continue;
    state.settings.bookmarks.push({ path: p, name: path.basename(p) || p });
  }
  return added.length;
}

module.exports = { scanSessions, mergeRecovered };
