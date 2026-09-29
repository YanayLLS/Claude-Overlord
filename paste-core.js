// Where a paste goes. Pure: index.html reads the DataTransfer and hands the
// facts over, main.js acts on the verdict.
// Self-check: paste-core.test.js
//
// The reason this is its own module: a paste that resolves to nothing used to
// be dropped on the floor. The renderer calls preventDefault() before handing
// off, so once it decides "files" there is no xterm paste left to fall back
// on — and main returned silently when no file path resolved. Chromium empties
// the DataTransfer whenever the clipboard read loses a race (delayed rendering
// from Office or an RDP bridge, a clipboard manager holding it open, a source
// app that has since quit), so a perfectly ordinary text paste could land in
// that hole and vanish. 'files' therefore means "main decides, reading the OS
// clipboard fresh", never "there must be files here".

// 'ignore' — a real input field owns this paste, not the terminal
// 'image'  — a bitmap is on the clipboard
// 'xterm'  — text is present; let xterm paste it, do NOT preventDefault
// 'files'  — file paths, or nothing legible at all
function pasteRoute({ intoInput, hasImageFile, hasNonImageFile, fileCount, hasTextItem, types } = {}) {
  if (intoInput) return 'ignore';
  if (hasImageFile) return 'image';
  if (hasNonImageFile || (fileCount || 0) > 0) return 'files';
  // items and types come from one snapshot, so an empty items list is no proof
  // of "no text" — but a types entry is proof of text, and xterm can have it.
  const t = types || [];
  if (hasTextItem || t.includes('text/plain') || t.includes('text')) return 'xterm';
  return 'files';
}

// xterm's own paste sink is a textarea, so tag alone can't tell the two apart.
function pasteIntoInput({ tag, isContentEditable, className } = {}) {
  if (isContentEditable) return true;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA') return false;
  return !String(className || '').split(/\s+/).includes('xterm-helper-textarea');
}

// CR is the terminal's line separator. A LF left inside a bracketed paste makes
// some readers submit part-way through instead of taking the whole block.
function normalizePasteText(text) {
  return String(text == null ? '' : text).replace(/\r\n|\n/g, '\r');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { pasteRoute, pasteIntoInput, normalizePasteText };
}
