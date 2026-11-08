// CPU saving (Settings → Agents): an agent you aren't looking at, idle with nothing of its own still
// running, gets its Claude process closed; its card stays, and opening it (or sending it anything)
// resumes the same session with `claude --resume`. A booted claude holds 250-400 MB and keeps
// repainting its status line.

const IDLE_MS = 60 * 1000; // ponytail: one fixed grace so clicking between agents doesn't restart them; a setting if asked
const KEY_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b.?|[\x00-\x1f\x7f]/g;

// Why this agent's Claude must keep running, or '' when it can sleep.
// ctx: what main.js keeps outside the agent object:
//   focused  - it is the agent open in the window
//   hasTerm  - it has a process
//   shell    - that process is the plain shell, not Claude
//   unsent   - messages are still on their way to it
//   servers  - dev servers it started are running
//   team     - it leads an agent team
//   draft    - text typed into its CLI box and not sent
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
  if (a.cronCount > 0) return 'scheduled loop'; // CronCreate jobs live in the CLI process
  if (a.pendingPrompt || ctx.unsent) return 'message on its way';
  if (ctx.servers) return 'dev server';
  if (ctx.team) return 'leads a team';
  if (String(ctx.draft || '').replace(KEY_RE, '').trim()) return 'unsent text in its box';
  return '';
}

// One sweep over [{ id, a, why }]: an agent's idle clock (a._idleSince) starts the first time it can
// sleep and resets whenever it can't. Returns the ids that have been idle for idleMs.
function dueToSleep(entries, now, idleMs = IDLE_MS) {
  const due = [];
  for (const { id, a, why } of entries) {
    if (why) { a._idleSince = 0; continue; }
    if (!a._idleSince) a._idleSince = now;
    else if (now - a._idleSince >= idleMs) due.push(id);
  }
  return due;
}

module.exports = { keepAwake, dueToSleep, IDLE_MS };
