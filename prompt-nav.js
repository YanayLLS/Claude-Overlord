// Prompt navigation over the terminal scrollback. Pure over rendered rows so it
// can be tested without xterm.
//
// Claude Code echoes every submitted prompt into the scrollback with the same
// marker it draws the live input line with ("❯ ", "> " at column 0 in some
// builds, or "│ > " in the older boxed skin). The live line must be excluded: it
// sits on the current screen, so "jump to it" scrolls nowhere and reads as a broken button.

const PROMPT_ROW_MARKER = /^\s*(?:❯|[│┃]\s+>\s)|^> /; // indented "> " is quoted output, not a prompt

// rows: rendered buffer lines, baseY: index of the first row of the current
// screen. Returns the buffer indices of submitted prompts, oldest first.
function promptRows(rows, baseY) {
  const out = [];
  for (let i = 0; i < rows.length && i < baseY; i++) {
    if (PROMPT_ROW_MARKER.test(rows[i])) out.push(i);
  }
  return out;
}

// The prompt's own text, for the rail's hover list. Only the first row — a
// wrapped prompt's tail is plenty for recognising it.
function promptText(row) {
  return row.replace(PROMPT_ROW_MARKER, '').replace(/\s*[│┃]\s*$/, '').trim();
}

// Index of the prompt the viewport is reading: the last one at or above its top
// row (+1: jumps land one row above the prompt). -1 when above all of them.
function activePrompt(lines, viewportY) {
  let idx = -1;
  for (let i = 0; i < lines.length && lines[i] <= viewportY + 1; i++) idx = i;
  return idx;
}

// idx may be out of range (seeded from a different list, or stale after the
// scrollback rolled) — clamp instead of refusing to move. total is the prompt
// count; `total` itself is the virtual "bottom of terminal" entry.
function nextNavIdx(idx, dir, total) {
  const cur = idx >= 0 && idx <= total ? idx : total;
  return Math.max(0, Math.min(total, cur + dir));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { promptRows, nextNavIdx, promptText, activePrompt };
}
