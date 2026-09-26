// URL links that span terminal rows. xterm's web-links addon only follows soft wraps
// (isWrapped); Claude hard-wraps long URLs with a newline + indent, so a click opened
// just the first row's piece. Shared by the renderer (index.html) and the node self-check.

const URL_RE = /https?:\/\/[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/g;
const MAX_ROWS = 20; // ponytail: cap on rows one URL may span; raise if longer URLs show up

// Does row i run on into row i+1? Soft wrap, or a hard wrap: row i filled to the edge
// (within `slack` cols) and row i+1 carries on with a non-space after its indent.
function continues(getLine, i, cols, slack = 2) {
  const next = getLine(i + 1);
  if (!next) return false;
  if (next.isWrapped) return true;
  const cur = getLine(i).text.replace(/\s+$/, '');
  return cur.length >= cols - slack && /^\s*\S/.test(next.text);
}

// getLine(i) → { text, isWrapped } | null for buffer row i (0-based).
// Returns the URLs touching row y as xterm link ranges (1-based x and y).
// ponytail: one char = one cell; wide (CJK) chars before a URL shift its range.
function urlLinksAt(getLine, y, cols) {
  if (!getLine(y)) return [];
  let top = y;
  while (top > 0 && y - top < MAX_ROWS && getLine(top - 1) && continues(getLine, top - 1, cols)) top--;
  let text = '', pos = []; // pos[k] = cell of text[k]
  for (let i = top; i - top < MAX_ROWS; i++) {
    let t = getLine(i).text, x0 = 0;
    if (i > top && !getLine(i).isWrapped) x0 = t.length - t.trimStart().length; // drop the indent
    const next = getLine(i + 1);
    if (!(next && next.isWrapped)) t = t.replace(/\s+$/, ''); // a soft wrap's trailing cells are real
    for (let x = x0; x < t.length; x++) { text += t[x]; pos.push({ x: x + 1, y: i + 1 }); }
    if (!continues(getLine, i, cols)) break;
  }
  const links = [];
  for (const m of text.matchAll(URL_RE)) {
    const start = pos[m.index], end = pos[m.index + m[0].length - 1];
    if (start.y <= y + 1 && end.y >= y + 1) links.push({ url: m[0], start, end });
  }
  return links;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { urlLinksAt };
}
