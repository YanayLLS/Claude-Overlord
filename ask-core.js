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

// Claude Code's permission dialog on screen — also for a sub-agent's tool (it asks in the
// parent's terminal) and for dangerous commands under bypassPermissions. Neither ever shows
// in the parent's transcript. `text` is terminal output with escapes stripped: spaces arrive
// as cursor moves, so the pattern tolerates them missing.
const PERM_DIALOG_RE = /Do\s*you\s*want\s*to\s*[^?]{0,300}\?[\s\S]{0,400}?1\.\s*Yes[\s\S]{0,200}?\d\.\s*No/;
const permDialogIn = (text) => PERM_DIALOG_RE.test(text || '');

module.exports = { applyAskRecord, permDialogIn };
