// CPU saving (Settings → Agents): an agent you aren't looking at, idle with nothing of its own still
// running, gets its Claude process closed; its card stays, and opening it (or sending it anything)
// resumes the same session with `claude --resume`. A booted claude holds 250-400 MB and keeps
// repainting its status line.

const IDLE_MS = 0; // immediate, as asked: leaving an idle agent (or it going idle while you're elsewhere) closes it

// Why this agent's Claude must keep running, or '' when it can sleep. The rule: idle = not working, no
// subagent running, no shell command running. The rest only guards what would break: the open agent, a CLI
// still booting or crashed, and a dialog or message that is mid-flight.
// ctx: what main.js keeps outside the agent object:
//   focused  - it is the agent open in the window
//   hasTerm  - it has a process
//   shell    - that process is the plain shell, not Claude
//   unsent   - messages are still on their way to it
function keepAwake(a, ctx) {
  if (a.archived || a.sleeping) return 'not running';
  if (ctx.focused) return 'open';
  if (!ctx.hasTerm || ctx.shell) return 'no Claude process';
  if (!a.claudeReady) return 'starting';
  if (a.crashed || a.orphanAlive) return 'recovering';
  if (!a.isWaiting || a.compacting) return 'working';
  if (a.bgTasks && a.bgTasks.size) return 'background shell or subagent';
  if (a.toolIds && a.toolIds.size) return 'tool running';
  if (a.permSent || a.ptyPerm || (a.askIds && a.askIds.size) || a.cliMenu) return 'waiting on you';
  if (a.pendingPrompt || ctx.unsent) return 'message on its way';
  return '';
}

// One sweep over [{ id, a, why }]: an agent's idle clock (a._idleSince) starts the first time it can
// sleep and resets whenever it can't. Returns the ids that have been idle for idleMs (0: at once).
function dueToSleep(entries, now, idleMs = IDLE_MS) {
  const due = [];
  for (const { id, a, why } of entries) {
    if (why) { a._idleSince = 0; continue; }
    if (!a._idleSince) a._idleSince = now;
    if (now - a._idleSince >= idleMs) due.push(id);
  }
  return due;
}

module.exports = { keepAwake, dueToSleep, IDLE_MS };
