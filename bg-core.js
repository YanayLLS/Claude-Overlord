// Background work that outlives a turn (run_in_background Bash, async Agent/fork).
// The transcript is the ledger: a launch is a structured tool result, an end is a
// <task-notification> with a final <status>. Turn-level state alone says "idle".

const NOTE_STILL_RUNNING = /background work of its own still running/;

function recordText(r) {
  if (r.type === 'queue-operation') return typeof r.content === 'string' ? r.content : '';
  if (r.type !== 'user') return '';
  const c = r.message?.content;
  if (typeof c === 'string') return c;
  return Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text || '').join('') : '';
}

// Mutates `tasks` (Set of task ids). Returns true if it changed.
function applyBgRecord(tasks, r) {
  const before = tasks.size;
  const tur = r.toolUseResult;
  if (tur && typeof tur === 'object') {
    if (tur.backgroundTaskId) tasks.add(tur.backgroundTaskId);
    if (tur.status === 'async_launched' && tur.agentId) tasks.add(tur.agentId);
    if (tur.resumedAgentId) tasks.add(tur.resumedAgentId); // SendMessage woke a finished agent
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
      // An agent that stopped with its own background work still going will notify again
      const pending = status === 'running' || NOTE_STILL_RUNNING.test(block);
      for (const id of ids) { if (pending) tasks.add(id); else tasks.delete(id); }
    }
  }
  return tasks.size !== before;
}

module.exports = { applyBgRecord };
