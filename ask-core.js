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

// Claude's live turn timer — "Sublimating… (10m 17s · ↓ 61.7k tokens)" — is on screen only while a
// turn runs (finished turns read "Cooked for 2m · done", no parenthesis). Spaces may be missing.
const LIVE_TURN_RE = /\((?:\d+h\s*)?(?:\d+m\s*)?\d+s\s*·/;
const liveTurnIn = (text) => LIVE_TURN_RE.test(text || '');

// Claude's question picker (AskUserQuestion / plan approval). Newer Claude Code writes the
// turn's message — question included — to the transcript only after it's answered, so the
// screen is the only live signal. Its footer: "Enter to select · ↑/↓ to navigate · Esc to cancel".
const QUESTION_DIALOG_RE = /Enter\s*to\s*select[\s\S]{0,60}?to\s*navigate[\s\S]{0,120}?Esc\s*to\s*cancel/;
const questionDialogIn = (text) => QUESTION_DIALOG_RE.test(text || '');

// The dialog that is live: on the settled screen a real one is the last thing drawn, and
// Claude's input box (its "shift+tab to cycle" / "? for shortcuts" footer) is hidden while it
// waits. The same text in redrawn history (/resume, resize) is followed by the input box.
const INPUT_BOX_RE = /shift\s*\+\s*tab\s*to\s*cycle|\?\s*for\s*shortcuts/;
function dialogAtEnd(text) {
  const tail = String(text || '').slice(-3000);
  for (const [kind, re] of [['ask', QUESTION_DIALOG_RE], ['perm', PERM_DIALOG_RE]]) {
    let last = null;
    for (const m of tail.matchAll(new RegExp(re.source, 'g'))) last = m;
    if (!last) continue;
    const after = tail.slice(last.index + last[0].length);
    if (after.length < 800 && !INPUT_BOX_RE.test(after)) return kind;
  }
  return null;
}

module.exports = { applyAskRecord, permDialogIn, liveTurnIn, questionDialogIn, dialogAtEnd };
