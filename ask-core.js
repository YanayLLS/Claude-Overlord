// Questions blocking on the user: an AskUserQuestion / ExitPlanMode tool_use with no
// tool_result yet. Exact — the dialog is open until that tool call gets its result.
const ASK_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

// Mutates `asks` (Set of tool_use ids). Returns true if it changed.
function applyAskRecord(asks, r) {
  const before = asks.size;
  const c = r.message?.content;
  if (r.type === 'system' && r.subtype === 'turn_duration') asks.clear();
  else if (Array.isArray(c)) {
    for (const b of c) {
      if (r.type === 'assistant' && b.type === 'tool_use' && ASK_TOOLS.has(b.name)) asks.add(b.id);
      if (r.type === 'user' && b.type === 'tool_result') asks.delete(b.tool_use_id);
    }
  }
  return asks.size !== before;
}

module.exports = { applyAskRecord };
