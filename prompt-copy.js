// What Ctrl+C copies when nothing is selected: the text sitting in Claude's
// prompt box. Ctrl+C still sends SIGINT, which wipes that text — so it gets
// grabbed off the screen buffer first.
//
// Pure over an array of rendered lines so it can be tested without xterm.

const BORDER = '[\\u2502|\\u2503\\u258C\\u2590\\u2506\\u250A\\u2551\\u2595\\u258F]';
const BOTH = new RegExp(`^\\s*${BORDER}\\s?(.*?)\\s*${BORDER}\\s*$`);
const LEFT = new RegExp(`^\\s*${BORDER}\\s?(.*?)\\s*$`);
const MARKER = /^\s*(?:>|❯|❱|\$)\s?/; // shell/Claude prompt char

// Text inside a box row, or null if the line isn't one. Right border optional:
// a wrapped line can run to the edge, and xterm trims trailing blanks.
function boxInner(line) {
  if (typeof line !== 'string') return null;
  const m = line.match(BOTH) || line.match(LEFT);
  return m ? m[1] : null;
}

// lines: rendered buffer rows, cursorIdx: index of the row holding the cursor.
function readPromptText(lines, cursorIdx) {
  const at = (i) => (i >= 0 && i < (lines || []).length ? lines[i] : undefined);
  if (boxInner(at(cursorIdx)) === null) {
    // ponytail: no box (plain shell, or a Claude build that dropped it) — the
    // cursor line alone is the best guess. Multi-line input there is rare.
    const raw = at(cursorIdx);
    return typeof raw === 'string' ? raw.replace(MARKER, '').trim() : '';
  }
  let top = cursorIdx, bot = cursorIdx;
  while (boxInner(at(top - 1)) !== null) top--;
  while (boxInner(at(bot + 1)) !== null) bot++;
  const rows = [];
  for (let y = top; y <= bot; y++) rows.push(boxInner(at(y)));
  // Continuation rows are padded to sit under the "> " marker — drop that same
  // width from them so pasting back gives the original text, indentation intact.
  const m = rows[0].match(MARKER);
  const pad = m ? m[0].length : 0;
  const out = rows.map((r, i) => (i === 0 ? r.replace(MARKER, '')
    : r.replace(new RegExp(`^ {0,${pad}}`), '')));
  return out.join('\n').trim();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { boxInner, readPromptText };
}
