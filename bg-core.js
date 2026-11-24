// Background work that outlives a turn (run_in_background Bash, async Agent/fork, teammates).
// The transcript is the ledger: a launch is a structured tool result, an end is a
// <task-notification> with a final <status>. Turn-level state alone says "idle".

const NOTE_STILL_RUNNING = /background work of its own still running/;
const SEEN_NOTICES_MAX = 200; // notices acted on, kept so a late copy isn't acted on twice

function recordText(r) {
  if (r.type === 'queue-operation') return typeof r.content === 'string' ? r.content : '';
  if (r.type !== 'user') return '';
  const c = r.message?.content;
  if (typeof c === 'string') return c;
  return Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text || '').join('') : '';
}

// Mutates `tasks` (Set of task ids; teammates as "tm:<name>"). Returns true if it changed.
function applyBgRecord(tasks, r) {
  const before = tasks.size;
  const tur = r.toolUseResult;
  if (tur && typeof tur === 'object') {
    // A quick agent's "finished" notice can be written before its launch result (parallel launches
    // are written when the whole batch returns): that launch is of a task already over.
    const launch = (id) => { if (!tasks.endedEarly?.delete(id)) tasks.add(id); };
    if (tur.backgroundTaskId) { launch(tur.backgroundTaskId); if (tasks.has(tur.backgroundTaskId)) (tasks.shells ||= new Set()).add(tur.backgroundTaskId); }
    // async Agent → agentId; a background Workflow run → taskId
    if (tur.status === 'async_launched' && (tur.agentId || tur.taskId)) launch(tur.agentId || tur.taskId);
    if (tur.resumedAgentId) tasks.add(tur.resumedAgentId); // SendMessage woke a finished agent
    // Agent-team teammate: working from spawn, and again whenever the lead messages it
    if (tur.status === 'teammate_spawned' && tur.name) tasks.add('tm:' + tur.name);
    const to = tur.routing?.target;
    if (tur.success && typeof to === 'string' && to.startsWith('@')) tasks.add('tm:' + to.slice(1));
    // TaskStop / KillShell end a task without a notification
    const stopped = tur.task_id || tur.shell_id;
    if (stopped && /^Successfully (stopped|killed)/.test(tur.message || '')) tasks.delete(stopped);
  }
  const text = recordText(r);
  if (text.includes('<task-notification>')) {
    for (const block of text.split('<task-notification>').slice(1)) {
      // One notification can cover several tasks (e.g. shells orphaned by a restart)
      const ids = [...block.matchAll(/<task-id>([^<]+)<\/task-id>/g)].map(m => m[1]);
      const status = block.match(/<status>([^<]+)<\/status>/)?.[1];
      if (!status) continue;
      // The same notice is written up to 3 times (enqueued, dequeued, delivered). Act on it once:
      // a late copy of an old "finished" must not end an agent that was resumed in between.
      // Keyed by a hash, capped: the whole block text, uncapped, grew by MBs on a long-lived agent.
      const key = require('crypto').createHash('sha1').update(block.split('</task-notification>')[0].trim()).digest('hex');
      const seen = tasks.seenNotices || (tasks.seenNotices = new Set());
      if (seen.has(key)) continue;
      seen.add(key);
      if (seen.size > SEEN_NOTICES_MAX) seen.delete(seen.values().next().value); // oldest first: Set keeps insertion order
      // An agent that stopped with its own background work still going will notify again
      const pending = status === 'running' || NOTE_STILL_RUNNING.test(block);
      for (const id of ids) {
        if (pending) tasks.add(id);
        else if (!tasks.delete(id)) {
          const early = tasks.endedEarly || (tasks.endedEarly = new Set());
          early.add(id);
          if (early.size > SEEN_NOTICES_MAX) early.delete(early.values().next().value);
        }
      }
    }
  }
  // A teammate's turn ended: it's done (its own shells' completions never reach its transcript,
  // so they can't be tracked — same as the lead's shells, they don't count as working).
  if (text.includes('<teammate-message')) {
    for (const m of text.matchAll(/<teammate-message[^>]*>\s*(\{[\s\S]*?\})\s*<\/teammate-message>/g)) {
      let j; try { j = JSON.parse(m[1]); } catch { continue; }
      if (j.type === 'idle_notification' && j.from) tasks.delete('tm:' + j.from);
    }
  }
  return tasks.size !== before;
}

// Background work that keeps the agent "working": agents, workflows, teammates. A background shell
// (often a dev server that never ends) doesn't — the CLI shows the turn "done · 1 shell still running".
function busyBgCount(tasks) {
  if (!tasks) return 0;
  let n = 0;
  for (const id of tasks) if (!tasks.shells?.has(id)) n++;
  return n;
}

module.exports = { applyBgRecord, busyBgCount };
