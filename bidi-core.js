// Pure helpers for Hebrew/Arabic in the terminal. Shared by the renderer (index.html) and
// the node self-check.
//
// Two kinds of RTL rows reach the terminal. Claude Code lays out its own prose, the typed
// prompt and tool-call headers in VISUAL order before writing them (letters and words
// flipped, numbers kept, brackets not mirrored; paragraph direction from the first strong
// letter), because terminals have no bidi — those rows look right as stored. Everything
// else — code, diffs, tool output, other programs — arrives in LOGICAL order, and xterm,
// which has no bidi (xtermjs/xterm.js#701) and whose DOM renderer isolates every Hebrew
// letter in its own inline-block span, shows it reversed. looksVisual() tells the two apart
// by Hebrew final letters (ם ן ך ף ץ end a word in logical text and start one in flipped
// text) and by where sentence punctuation sits; rows without a clue count as Claude's.
//
// The renderer reorders the spans of logical rows into visual order (visualGroups) and maps
// mouse positions on those rows back to buffer columns (visualCells). Copies run visual rows
// back to logical order (toLogical) so a paste elsewhere reads right.

const RTL_RE = /[֐-ࣿיִ-﷿ﹰ-﻿]/;

// Whether a row's text has any RTL letter — rows without one are left alone.
function hasRtl(text) { return RTL_RE.test(text); }

// Split text into grapheme-ish units: a base character plus its combining marks (niqqud,
// accents, ZWJ sequences), so a mark never ends up on the wrong letter after reordering.
function graphemes(text) {
  return text.match(/\P{M}[\p{M}‍]*|[\p{M}‍]+/gu) || [];
}

// Bidi class of a unit, from its first code point.
//  R: RTL letter, L: other letter/strong LTR, EN: digit, CS: separator that may sit
//  inside a number (kept with digits when between two), N: neutral (space, punctuation).
function bidiClass(unit) {
  const c = unit.codePointAt(0);
  if ((c >= 0x0590 && c <= 0x08FF) || (c >= 0xFB1D && c <= 0xFDFF) || (c >= 0xFE70 && c <= 0xFEFF)) {
    if (/^\p{M}/u.test(unit)) return 'N'; // a stray mark with no base: neutral
    if ((c >= 0x0660 && c <= 0x0669) || (c >= 0x06F0 && c <= 0x06F9)) return 'EN'; // Arabic-Indic digits
    return 'R';
  }
  if (c >= 0x30 && c <= 0x39) return 'EN';
  if (/^[.,:\/+\-%]$/.test(unit)) return 'CS';
  if (/^\p{L}/u.test(unit)) return 'L';
  return 'N';
}

const MIRROR = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '«': '»', '»': '«' };

// Nearest strong class (R/L) before index i; at the line start, the paragraph direction.
function strongBefore(cls, i, para) {
  for (let k = i - 1; k >= 0; k--) if (cls[k] === 'R' || cls[k] === 'L') return cls[k];
  return para;
}

// Embedding level per unit. LTR paragraph: 0 = LTR, 1 = RTL run, 2 = number inside an RTL
// run. RTL paragraph (rtlPara): 1 = RTL, 2 = Latin or number inside it.
// `cursor` is the index of the unit under the terminal cursor, or -1: a blank cursor cell
// right after an RTL letter joins the run, so the caret sits where the next letter will
// appear (the run's left end) instead of at its right end as a plain neutral would.
function levels(units, cursor = -1, rtlPara = false) {
  const cls = units.map(bidiClass);
  const n = cls.length, para = rtlPara ? 'R' : 'L', base = rtlPara ? 1 : 0;
  // W4: a separator between two digits is part of the number; any other separator is neutral.
  for (let i = 1; i < n - 1; i++) if (cls[i] === 'CS' && cls[i - 1] === 'EN' && cls[i + 1] === 'EN') cls[i] = 'EN';
  for (let i = 0; i < n; i++) if (cls[i] === 'CS') cls[i] = 'N';
  const lv = new Array(n).fill(base);
  // W7 + I1/I2: a number keeps its digits in order; after an R letter (always, in an RTL
  // paragraph) it rides inside the RTL flow at level 2, after L text in an LTR paragraph it is
  // plain LTR text at level 0.
  for (let i = 0; i < n; i++) {
    if (cls[i] !== 'EN') continue;
    let j = i; while (j < n && cls[j] === 'EN') j++;
    const inR = rtlPara || strongBefore(cls, i, para) === 'R';
    for (let k = i; k < j; k++) lv[k] = inR ? 2 : 0;
    i = j - 1;
  }
  for (let i = 0; i < n; i++) { if (cls[i] === 'R') lv[i] = 1; else if (cls[i] === 'L') lv[i] = rtlPara ? 2 : 0; }
  // N1/N2: a neutral run takes the direction of its two neighbours when they agree (a number in
  // the RTL flow counts as R); otherwise the paragraph direction. Line edges count as the paragraph.
  const dirAt = (k) => cls[k] === 'R' ? 'R' : cls[k] === 'L' ? 'L' : lv[k] === 2 && !rtlPara ? 'R' : lv[k] === 2 ? 'R' : 'L';
  for (let i = 0; i < n; i++) {
    if (cls[i] !== 'N') continue;
    let j = i; while (j < n && cls[j] === 'N') j++;
    const before = i > 0 ? dirAt(i - 1) : para, after = j < n ? dirAt(j) : para;
    const l = before !== after ? base : before === 'R' ? 1 : (rtlPara ? 2 : 0);
    for (let k = i; k < j; k++) lv[k] = l;
    i = j - 1;
  }
  if (!rtlPara && cursor > 0 && cursor < n && cls[cursor] === 'N' && lv[cursor] === 0 && /^\s$/.test(units[cursor]) && lv[cursor - 1] % 2 === 1) lv[cursor] = 1;
  return lv;
}

// Visual order of the units: an array of logical indices, left to right on screen.
// (L2: reverse every run at the highest level, then every run at the next level down, ...)
// Its own inverse: feeding it a visual row (same paragraph direction) gives the logical one.
function visualOrder(units, cursor = -1, rtlPara = false) {
  const lv = levels(units, cursor, rtlPara);
  const order = units.map((_, i) => i);
  const max = Math.max(0, ...lv);
  for (let level = max; level >= 1; level--) {
    let i = 0;
    while (i < order.length) {
      if (lv[order[i]] < level) { i++; continue; }
      let j = i; while (j < order.length && lv[order[j]] >= level) j++;
      for (let a = i, b = j - 1; a < b; a++, b--) { const t = order[a]; order[a] = order[b]; order[b] = t; }
      i = j;
    }
  }
  return order;
}

// Units are { text, key } where key names the source span (style). Returns the row as
// groups in visual order, consecutive units of one source span merged: [{ key, text }].
// Brackets at an RTL level are mirrored so they still enclose what they enclosed.
function visualGroups(units, cursor = -1) {
  const texts = units.map(u => u.text);
  const lv = levels(texts, cursor);
  const order = visualOrder(texts, cursor);
  const out = [];
  for (const i of order) {
    let t = texts[i];
    if (lv[i] % 2 === 1 && MIRROR[t]) t = MIRROR[t];
    const last = out[out.length - 1];
    if (last && last.key === units[i].key) last.text += t;
    else out.push({ key: units[i].key, text: t });
  }
  return out;
}

// Mouse mapping. `cells` are the row's buffer cells in storage order, { text, width }
// (continuation cells of wide characters left out). Returns, per visual column left to
// right: v2l — the buffer column drawn there; rtl — whether that cell is in a flipped run,
// where the cell's left edge is its logical right edge (a click on its left half means
// "after it" in the buffer).
function visualCells(cells, cursor = -1) {
  const texts = cells.map(c => c.text);
  const lv = levels(texts, cursor);
  const order = visualOrder(texts, cursor);
  const xs = []; let x = 0;
  for (const c of cells) { xs.push(x); x += c.width || 1; }
  const v2l = [], rtl = [];
  for (const i of order) for (let k = 0; k < (cells[i].width || 1); k++) { v2l.push(xs[i] + k); rtl.push(lv[i] % 2 === 1); }
  return { v2l, rtl };
}

// Whether a row's Hebrew is already in visual order (Claude Code's own layout) rather than
// logical. Final letters decide: ם ן ך ף ץ end a word in logical Hebrew and so start one in
// a flipped word. Sentence punctuation helps too: Claude Code treats a Hebrew-first line as
// an RTL paragraph, so its full stop lands at the line's left end. No clue → visual, since
// Claude Code's own text is most of what a terminal here shows.
const FINAL = 'ךםןףץ';
function looksVisual(line) {
  let logical = 0, visual = 0;
  for (const w of line.match(/[א-ת][א-ת֑-ׇ]*/g) || []) {
    if (w.length < 2) continue;
    if (FINAL.includes(w[w.length - 1])) logical += 2;
    if (FINAL.includes(w[0])) visual += 2;
  }
  const t = line.trim();
  if (/^[.,:;!?]\s*[א-ת]/.test(t)) visual += 1;
  if (/[א-ת]\s*[.,:;!?]$/.test(t)) logical += 1;
  return visual >= logical;
}

// Copied text back to logical order: lines Claude Code wrote visually are run through the
// same bidi rules again (the reorder is an involution); logical lines are left alone. The
// paragraph direction of a visual line is guessed from which script has more letters.
function toLogical(text) {
  return text.split('\n').map((line) => {
    if (!hasRtl(line) || !looksVisual(line)) return line;
    const units = graphemes(line), cls = units.map(bidiClass);
    let r = 0, l = 0; for (const c of cls) { if (c === 'R') r++; else if (c === 'L') l++; }
    return visualOrder(units, -1, r > l).map(i => units[i]).join('');
  }).join('\n');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { hasRtl, graphemes, visualOrder, visualGroups, visualCells, looksVisual, toLogical };
}
