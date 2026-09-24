// Pure helpers for Windows-style Shift+arrow selection in the terminal prompt.
// Shared by the renderer (index.html) and the node self-check. No DOM, no xterm.

// The bytes the unshifted key would send, so Claude still moves its cursor.
// `app` = xterm's application-cursor-keys mode (ESC O x instead of ESC [ x).
// `ctrl` = word jump, sent as the Ctrl-modified key (ESC [1;5 x) like any terminal does.
function shiftNavSeq(key, app, ctrl) {
  const c = { ArrowLeft: 'D', ArrowRight: 'C', Home: 'H', End: 'F' }[key];
  if (!c) return null;
  return ctrl ? '\x1b[1;5' + c : (app ? '\x1bO' : '\x1b[') + c;
}

// Selected span on the prompt row, from the anchor column to the cursor column.
function selRange(anchorX, cursorX) {
  return { col: Math.min(anchorX, cursorX), len: Math.abs(cursorX - anchorX) };
}

// Bytes that erase the selection: backspaces when the cursor sits at its right end,
// forward-deletes when at its left end.
function deleteSelSeq(anchorX, cursorX) {
  const n = Math.abs(cursorX - anchorX);
  return (cursorX > anchorX ? '\x7f' : '\x1b[3~').repeat(n);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { shiftNavSeq, selRange, deleteSelSeq };
}
