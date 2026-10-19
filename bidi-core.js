// Pure helpers for showing right-to-left text (Hebrew, Arabic) the right way round in
// the terminal. Shared by the renderer (index.html) and the node self-check.
//
// xterm's DOM renderer draws each row as a line of inline-block spans, one per run of
// same-styled cells — and a new span whenever the glyph width differs, which for Hebrew
// (no glyphs in the monospace font, so a proportional fallback) is every letter. An
// inline-block is a bidi isolate, so the browser can't reorder across them, and the row
// shows in storage order: letters reversed, words reversed. No bidi in xterm itself
// (xtermjs/xterm.js#701). So after each render we reorder the spans of rows that hold
// RTL text, by a small Unicode-bidi (an LTR paragraph with no explicit embeddings — all
// a terminal ever shows): RTL letters flip, numbers inside keep their digit order,
// neutrals between RTL letters flip with them, neutrals on the edges stay put, and
// brackets inside a flipped run are mirrored. The buffer is untouched; only pixels move.
// The same ordering maps mouse positions back to buffer columns (visualCells), so a drag
// over Hebrew selects the letters under the pointer.

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

// Nearest strong class (R/L) before index i, 'L' at the line start (sos of an LTR paragraph).
function strongBefore(cls, i) {
  for (let k = i - 1; k >= 0; k--) if (cls[k] === 'R' || cls[k] === 'L') return cls[k];
  return 'L';
}

// Embedding level per unit (0 = LTR, 1 = RTL, 2 = number inside RTL). LTR paragraph.
// `cursor` is the index of the unit under the terminal cursor, or -1: a blank cursor cell
// right after an RTL letter joins the run, so the caret sits where the next letter will
// appear (the run's left end) instead of at its right end as a plain neutral would.
function levels(units, cursor = -1) {
  const cls = units.map(bidiClass);
  const n = cls.length;
  // W4: a separator between two digits is part of the number; any other separator is neutral.
  for (let i = 1; i < n - 1; i++) if (cls[i] === 'CS' && cls[i - 1] === 'EN' && cls[i + 1] === 'EN') cls[i] = 'EN';
  for (let i = 0; i < n; i++) if (cls[i] === 'CS') cls[i] = 'N';
  const lv = new Array(n).fill(0);
  // W7 + I2: a number whose nearest strong letter before it is R belongs to the RTL flow at
  // level 2 (digits keep their order, the number moves with the run); after L text or at the
  // line start it is ordinary LTR text at level 0.
  for (let i = 0; i < n; i++) {
    if (cls[i] !== 'EN') continue;
    let j = i; while (j < n && cls[j] === 'EN') j++;
    if (strongBefore(cls, i) === 'R') for (let k = i; k < j; k++) lv[k] = 2;
    i = j - 1;
  }
  // N1/N2: a neutral run flips when the strong text on both sides is R (a flipped number counts
  // as R); otherwise it takes the paragraph direction. Line edges count as L.
  for (let i = 0; i < n; i++) {
    if (cls[i] !== 'N') continue;
    let j = i; while (j < n && cls[j] === 'N') j++;
    const before = i > 0 && (cls[i - 1] === 'R' || lv[i - 1] === 2);
    const after = j < n && (cls[j] === 'R' || lv[j] === 2);
    if (before && after) for (let k = i; k < j; k++) lv[k] = 1;
    i = j - 1;
  }
  for (let i = 0; i < n; i++) if (cls[i] === 'R') lv[i] = 1;
  if (cursor > 0 && cursor < n && cls[cursor] === 'N' && lv[cursor] === 0 && /^\s$/.test(units[cursor]) && lv[cursor - 1] % 2 === 1) lv[cursor] = 1;
  return lv;
}

// Visual order of the units: an array of logical indices, left to right on screen.
// (L2: reverse every run at the highest level, then every run at the next level down, ...)
function visualOrder(units, cursor = -1) {
  const lv = levels(units, cursor);
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { hasRtl, graphemes, visualOrder, visualGroups, visualCells };
}
