// Ctrl+Shift+T, like a browser's reopen-closed-tab: brings back the last archived
// agent, and again for the one before. The renderer keeps a stack of ids it
// archived this session (newest last); when that runs dry — after a reload, or
// for agents archived from another window — the fallback is the most recently
// archived agent by archivedAt (main stamps it), then the highest id.
// Returns the id to unarchive, or null. Pops the stack as it goes.
function nextReopen(stack, agents) {
  while (stack.length) {
    const id = stack.pop();
    if (agents.get(id)?.archived) return id;
  }
  let best = null, bestAt = -1, bestId = -1;
  for (const [id, a] of agents) {
    if (!a.archived) continue;
    const at = a.archivedAt || 0;
    if (at > bestAt || (at === bestAt && id > bestId)) { best = id; bestAt = at; bestId = id; }
  }
  return best;
}

// Record an archive on the stack: newest last, no duplicates.
function noteArchived(stack, id) {
  const i = stack.indexOf(id);
  if (i >= 0) stack.splice(i, 1);
  stack.push(id);
}

if (typeof module !== 'undefined' && module.exports) module.exports = { nextReopen, noteArchived };
