// Claude Code can hand a session to its background daemon (/background, `claude --bg`).
// The daemon then owns that session: it keeps it running after Overlord's pty dies and
// respawns its worker when the worker is killed. If Overlord also runs `claude --resume`
// on that session, two copies do the same work and both bill. So before Overlord runs a
// session itself it stops the daemon's job, through the CLI so the daemon doesn't respawn it.
const fs = require('fs');
const path = require('path');

const SETTLED = new Set(['done', 'stopped', 'failed', 'killed']);

// The daemon's short id for sessionId when it has an unfinished job for it, else null.
function unsettledJobFor(jobsDir, sessionId) {
  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
  const short = sessionId.slice(0, 8);
  let s;
  try { s = JSON.parse(fs.readFileSync(path.join(jobsDir, short, 'state.json'), 'utf8')); } catch { return null; }
  if (s.sessionId !== sessionId && s.resumeSessionId !== sessionId) return null;
  if (SETTLED.has(s.state)) return null;
  return /^[0-9a-f]{8}$/i.test(s.daemonShort || short) ? (s.daemonShort || short) : null;
}

module.exports = { unsettledJobFor };
