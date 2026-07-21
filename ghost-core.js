// Pure helpers for terminal ghost-text autocomplete. Shared by the renderer
// (index.html) and the node self-check below. No DOM, no xterm — just strings.

// Parse one translated terminal row (the Claude Code prompt box line) and the
// cursor column into { ok, atEnd, prefix }.
//   ok    — this row is the prompt INPUT line (bordered box + `>`/`❯` marker)
//   atEnd — nothing but spaces sit between the cursor and the closing border
//   prefix— the text the user has typed on this line (marker + padding stripped)
// ponytail: marker set is `>`/`❯` and border is `│`/`|`. If Claude Code reskins
// its input box, widen these two char classes — that's the whole upgrade path.
function parsePromptRow(rowStr, cursorX) {
  const m = rowStr.match(/^\s*[│|]\s?(.*?)\s*([│|])\s*$/);
  if (!m) return { ok: false };
  const mk = m[1].match(/^([>❯])\s?(.*)$/);
  if (!mk) return { ok: false }; // no prompt marker → a hint/border line, not input
  const prefix = mk[2].replace(/\s+$/, '');
  const closeIdx = rowStr.lastIndexOf(m[2]);
  const rightOfCursor = rowStr.slice(cursorX, closeIdx);
  const atEnd = !/\S/.test(rightOfCursor);
  return { ok: true, atEnd, prefix };
}

// Turn the model's raw reply into the continuation to show after the cursor.
// Strips to one line, unwraps stray quotes, and drops any echo of the prefix.
function extractContinuation(prefix, modelText) {
  if (!modelText) return '';
  let t = modelText.replace(/\r/g, '').split('\n')[0];
  t = t.replace(/^\s*["'`]|["'`]\s*$/g, '');
  const tl = t.replace(/^\s+/, '');
  if (prefix && tl.startsWith(prefix)) t = tl.slice(prefix.length);
  return t.replace(/\s+$/, '');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parsePromptRow, extractContinuation };
}
