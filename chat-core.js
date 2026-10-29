// Chat view helpers with no DOM: how a tool call reads ("Ran git status"), what a run of calls sums up to
// ("Ran 2 commands, read 3 files"), and an edit's line diff. Page globals, and module.exports for the tests.

const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
const hostOf = (u) => { try { return new URL(u).host; } catch { return u || ''; } };

// { kind, verb, target, mono }: kind picks the icon and how the summary counts it; target is shown mono when it's code.
function toolView(ev, running) {
  const a = ev.args || {}, n = ev.name || '';
  const v = (done, now) => running ? now : done;
  switch (n) {
    case 'Bash': case 'PowerShell': return a.description ? { kind: 'cmd', verb: v('Ran', 'Running'), target: a.description, mono: false } : { kind: 'cmd', verb: v('Ran', 'Running'), target: a.command || '', mono: true };
    case 'Read': return { kind: 'read', verb: v('Read', 'Reading'), target: baseName(a.file_path), mono: true };
    case 'Edit': case 'MultiEdit': return { kind: 'edit', verb: v('Edited', 'Editing'), target: baseName(a.file_path), mono: true };
    case 'Write': return { kind: 'edit', verb: v('Wrote', 'Writing'), target: baseName(a.file_path), mono: true };
    case 'NotebookEdit': return { kind: 'edit', verb: v('Edited', 'Editing'), target: baseName(a.notebook_path), mono: true };
    case 'Grep': return { kind: 'search', verb: v('Searched', 'Searching'), target: a.pattern || '', mono: true };
    case 'Glob': return { kind: 'search', verb: v('Listed', 'Listing'), target: a.pattern || a.glob || '', mono: true };
    case 'WebFetch': return { kind: 'web', verb: v('Fetched', 'Fetching'), target: hostOf(a.url), mono: false };
    case 'WebSearch': return { kind: 'web', verb: v('Searched the web', 'Searching the web'), target: a.query || '', mono: false };
    case 'Task': case 'Agent': return { kind: 'agent', verb: v('Agent', 'Agent'), target: a.description || a.subagent_type || '', mono: false };
    case 'TodoWrite': return { kind: 'todo', verb: v('Updated the plan', 'Updating the plan'), target: '', mono: false };
    case 'AskUserQuestion': return { kind: 'ask', verb: v('Asked', 'Asking'), target: a.question || '', mono: false };
    case 'ExitPlanMode': return { kind: 'plan', verb: v('Proposed a plan', 'Proposing a plan'), target: '', mono: false };
    case 'Artifact': return a.title || a.file_path ? { kind: 'artifact', verb: v('Published', 'Publishing'), target: a.title || baseName(a.file_path), mono: !a.title } : { kind: 'artifact', verb: v('Used Artifacts', 'Using Artifacts'), target: a.action || '', mono: false };
    case 'Skill': return { kind: 'tool', verb: v('Used skill', 'Using skill'), target: a.skill || '', mono: true };
    default: return { kind: 'tool', verb: n.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '').replace(/_/g, ' ') || 'Tool', target: '', mono: false };
  }
}

// "Ran 2 commands, read 3 files, edited main.js": the collapsed line for a run of calls, like Claude's apps.
function groupSummary(evs) {
  const by = {};
  for (const ev of evs) { const t = toolView(ev); (by[t.kind] ||= []).push(t); }
  const n = (k) => (by[k] || []).length;
  const pl = (c, one, many) => c === 1 ? one : `${c} ${many}`;
  const files = (k) => [...new Set(by[k].map(t => t.target).filter(Boolean))];
  const parts = [];
  if (n('cmd')) parts.push('ran ' + pl(n('cmd'), 'a command', 'commands'));
  if (n('read')) { const f = files('read'); parts.push('read ' + (f.length === 1 ? f[0] : pl(f.length || n('read'), 'a file', 'files'))); }
  if (n('edit')) { const f = files('edit'); parts.push('edited ' + (f.length === 1 ? f[0] : pl(f.length || n('edit'), 'a file', 'files'))); }
  if (n('search')) parts.push('searched ' + pl(n('search'), 'once', 'times'));
  if (n('web')) parts.push('browsed ' + pl(n('web'), 'a page', 'pages'));
  if (n('agent')) parts.push('ran ' + pl(n('agent'), 'an agent', 'agents'));
  if (n('todo')) parts.push('updated the plan');
  if (n('ask')) parts.push('asked ' + pl(n('ask'), 'a question', 'questions'));
  if (n('plan')) parts.push('proposed a plan');
  if (n('tool')) parts.push('used ' + pl(n('tool'), 'a tool', 'tools'));
  if (n('artifact')) parts.push('used ' + pl(n('artifact'), 'Artifacts', 'Artifacts calls'));
  const s = parts.join(', ') || pl(evs.length, 'used a tool', 'tools used');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Line diff (LCS) of an edit: rows of { t: ' ' | '-' | '+', s }, unchanged runs folded to 3 lines of context.
// ponytail: O(n·m) table, capped at DIFF_CELLS; bigger edits show as all-removed then all-added.
const DIFF_CELLS = 400000;
function lineDiff(oldText, newText) {
  const lines = (t) => t ? String(t).replace(/\n$/, '').split('\n') : []; // a closing newline isn't an extra blank row
  const a = lines(oldText), b = lines(newText);
  let rows = [];
  if (a.length * b.length > DIFF_CELLS) rows = a.map(s => ({ t: '-', s })).concat(b.map(s => ({ t: '+', s })));
  else {
    const m = a.length, n = b.length, L = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0, j = 0;
    while (i < m && j < n) { if (a[i] === b[j]) { rows.push({ t: ' ', s: a[i] }); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) rows.push({ t: '-', s: a[i++] }); else rows.push({ t: '+', s: b[j++] }); }
    while (i < m) rows.push({ t: '-', s: a[i++] });
    while (j < n) rows.push({ t: '+', s: b[j++] });
  }
  const add = rows.filter(r => r.t === '+').length, del = rows.filter(r => r.t === '-').length;
  const out = [];
  for (let k = 0; k < rows.length; k++) {
    if (rows[k].t !== ' ') { out.push(rows[k]); continue; }
    let e = k; while (e < rows.length && rows[e].t === ' ') e++;
    const run = rows.slice(k, e), head = k === 0 ? 0 : 3, tail = e === rows.length ? 0 : 3;
    if (run.length > head + tail + 1) { out.push(...run.slice(0, head), { t: '…', s: '' }, ...run.slice(run.length - tail)); }
    else out.push(...run);
    k = e - 1;
  }
  return { rows: out, add, del };
}

// @file suggestions: file name starting with the query, then containing it, then the path containing it, then the
// query's letters in order (fuzzy). Shorter paths first within a rank. q '' lists the shallowest files.
function matchFiles(files, q, max = 12) {
  q = String(q || '').toLowerCase().replace(/\\/g, '/');
  const rank = (f) => {
    const p = f.toLowerCase(), b = baseName(p);
    if (!q) return 0;
    if (b.startsWith(q)) return 0; if (b.includes(q)) return 1; if (p.includes(q)) return 2;
    let i = 0; for (const ch of p) if (ch === q[i]) i++;
    return i === q.length ? 3 : -1;
  };
  return files.map(f => [rank(f), f]).filter(r => r[0] >= 0)
    .sort((x, y) => x[0] - y[0] || x[1].split('/').length - y[1].split('/').length || x[1].length - y[1].length)
    .slice(0, max).map(r => r[1]);
}

// git's unified diff → [{ file, add, del, created, deleted, rows: [{ t: ' '|'+'|'-'|'…', s }] }], hunks separated by a fold.
// Rows carry their line number (n: the new file's, or the old file's for a removed line); each hunk opens with a fold
// row holding git's context ("function foo()") and its first line.
function parseUnified(text) {
  const files = []; let f = null, oldN = 0, newN = 0, hunk = false; // in a hunk, "--- x" is a removed "-- x", not a header
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('diff --git ')) { const m = / b\/(.+)$/.exec(line); f = { file: m ? m[1] : line.slice(11), add: 0, del: 0, created: false, deleted: false, rows: [] }; files.push(f); hunk = false; continue; }
    if (!f) continue;
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(line);
    if (line.startsWith('new file mode')) f.created = true;
    else if (line.startsWith('deleted file mode')) f.deleted = true;
    else if (h) { hunk = true; oldN = +h[1]; newN = +h[2]; f.rows.push({ t: '…', s: line.replace(/^(@@[^@]*@@).*$/, '$1') + (h[3] ? ' ' + h[3] : ''), n: newN }); }
    else if (!hunk && /^(---|\+\+\+|index |similarity|rename |old mode|new mode|Binary)/.test(line)) continue;
    // o / n: the line's number in the old and the new file (a removed line has no new number, an added one no old).
    else if (line[0] === '+') { f.rows.push({ t: '+', s: line.slice(1), n: newN++ }); f.add++; }
    else if (line[0] === '-') { f.rows.push({ t: '-', s: line.slice(1), o: oldN++ }); f.del++; }
    else if (line[0] === ' ') { f.rows.push({ t: ' ', s: line.slice(1), o: oldN++, n: newN++ }); }
  }
  return files;
}

// "main.js:2032", "src/a/b.ts:12:5", "C:\w\x.py:7" in a reply → [{ index, length, file, line }]. A name needs an
// extension and the line a number, so "12:30" or "http://x:80" don't count.
const FILE_REF = /(^|[\s(\[`'"*>])((?:[A-Za-z]:[\\/])?(?:[\w.@-]+[\\/])*[\w@-][\w.@-]*\.[A-Za-z][\w]{0,7}):(\d{1,6})(?::\d+)?(?=$|[\s)\]`'",.;:!?<*])/g;
function fileRefs(text) {
  const out = []; let m;
  FILE_REF.lastIndex = 0;
  while ((m = FILE_REF.exec(text))) { if (/^https?$/i.test(m[2])) continue; out.push({ index: m.index + m[1].length, length: m[0].length - m[1].length, file: m[2], line: +m[3] }); }
  return out;
}

// A whole inline-code span that is one absolute file path ("C:\\w\\shot.png", "~/x/a.md", "/home/a/b.ts") → { file, name,
// dir, img }: shown as the file's name with its folder, the full path on hover. Relative names stay code.
function pathRef(text) {
  const t = String(text || '').trim();
  if (!/^(?:[A-Za-z]:[\\/]|~[\\/]|\/)[^\n<>"|?*]*[^\\/\s]\.[A-Za-z0-9]{1,8}$/.test(t)) return null;
  const parts = t.split(/[\\/]/).filter(Boolean);
  return { file: t, name: parts[parts.length - 1], dir: parts.length > 1 ? parts[parts.length - 2] : '', img: /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(t) };
}

// Dictated words dropped in at the caret: a space before them unless the text there already ends in whitespace, and one
// after unless what follows starts with it. The recognizer capitalises every phrase, so mid-sentence its first letter
// goes lower case (not "I" or an acronym like "API").
// A recorded take as a 16-bit mono WAV file (what whisper reads): the 44-byte header, then each sample clamped to ±1.
function wavBytes(samples, rate) {
  const b = new ArrayBuffer(44 + samples.length * 2), v = new DataView(b), str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) { const x = Math.max(-1, Math.min(1, samples[i])); v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true); }
  return b;
}

function dictJoin(pre, words, post) {
  if (!words) return pre + post;
  if (pre.trim() && !/[.!?:]\s*$|\n\s*$/.test(pre) && !/^(I\b|[A-Z]{2,})/.test(words)) words = words[0].toLowerCase() + words.slice(1);
  return pre + (pre && !/\s$/.test(pre) ? ' ' : '') + words + (post && !/^\s/.test(post) ? ' ' : '') + post;
}

// The reply Claude is still writing, read off the CLI's screen rows (the transcript only gets a block once it's done):
// the newest "● text" block between the latest prompt and the working spinner. '' when there's none, it's a tool call,
// or the turn is over. ponytail: plain text as the CLI drew it (its markdown already rendered); the transcript's
// version replaces it as soon as the block lands.
function liveReply(lines) {
  let s = -1;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 60); i--) if (/^\s*[·✢✳✶✻✽*]\s+\p{Lu}[^…]{0,40}…\s*\(/u.test(lines[i])) { s = i; break; }
  if (s < 0) return '';
  let b = -1;
  for (let i = s - 1; i >= Math.max(0, s - 400); i--) {
    if (/^\s*[●⏺]\s/.test(lines[i])) { b = i; break; }
    if (/^>\s/.test(lines[i])) return ''; // the latest prompt: no reply yet this turn
  }
  if (b < 0) return '';
  const first = lines[b].replace(/^\s*[●⏺]\s+/, '');
  if (/^[A-Z][\w-]*(\(|$)/.test(first)) return ''; // "● Bash(…)", "● Read(…)": a call, its row is in the chat already
  const body = [first, ...lines.slice(b + 1, s).map(l => l.replace(/^ {2}/, ''))];
  while (body.length && !body[body.length - 1].trim()) body.pop();
  return body.join('\n').trim();
}

// A full-screen CLI dialog (double-Esc rewind, /config, /model, /permissions, /mcp…) is up: its "Esc to cancel/exit"
// footer is among the last rows. The normal prompt ends in its box and mode line instead.
function screenDialog(rows) {
  const tail = rows.filter(r => r.trim()).slice(-3).join('\n');
  return /\besc to (cancel|exit|go back|close)\b/i.test(tail) && !/esc to interrupt/i.test(tail);
}

// ── Shared by the Chat view's thread (chat-ui.js) and reply box (chat-composer.js), so both read text the same way ──
// A link as it's written in text: up to the first space, a closing bracket or quote, minus trailing punctuation.
const CHAT_URL_SRC = 'https?:\\/\\/[^\\s<>"]*[^\\s<>".,;:!?)\\]\']';
const chatUrlRe = (flags = '') => new RegExp(CHAT_URL_SRC, flags);
function escHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// Terminal text (a command's output, a background shell's log, a preview) as HTML that keeps its colours: ANSI SGR codes
// become spans, every other control code is dropped, and a diff (a unified one, or opts.diff) gets its lines coloured.
// One for every block of raw text the chat shows.
function termHtml(text, opts = {}) {
  const hex = (r, g, b) => '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  const c256 = (n) => { if (n >= 232) { const v = 8 + (n - 232) * 10; return hex(v, v, v); } n -= 16; const c = (x) => (x ? 55 + x * 40 : 0); return hex(c(Math.floor(n / 36)), c(Math.floor(n / 6) % 6), c(n % 6)); };
  const st = { fg: null, rgb: null, b: false, dim: false, i: false, u: false };
  const sgr = (ps) => {
    for (let k = 0; k < ps.length; k++) {
      const n = ps[k];
      if (n === 0) Object.assign(st, { fg: null, rgb: null, b: false, dim: false, i: false, u: false });
      else if (n === 1) st.b = true; else if (n === 2) st.dim = true; else if (n === 3) st.i = true; else if (n === 4) st.u = true;
      else if (n === 22) st.b = st.dim = false; else if (n === 23) st.i = false; else if (n === 24) st.u = false;
      else if (n >= 30 && n <= 37) { st.fg = n - 30; st.rgb = null; } else if (n >= 90 && n <= 97) { st.fg = n - 82; st.rgb = null; } else if (n === 39) st.fg = st.rgb = null;
      else if (n === 38 || n === 48) { // 256-colour or true colour; a background one is skipped
        const fg = n === 38;
        if (ps[k + 1] === 5) { const v = ps[k + 2]; k += 2; if (fg && v != null) { if (v < 16) { st.fg = v; st.rgb = null; } else { st.rgb = c256(v); st.fg = null; } } }
        else if (ps[k + 1] === 2) { const [r, g, b] = ps.slice(k + 2, k + 5); k += 4; if (fg) { st.rgb = `rgb(${r},${g},${b})`; st.fg = null; } }
      }
    }
  };
  const open = () => {
    const cls = [st.fg != null ? 'ansi-fg' + st.fg : '', st.b ? 'ansi-b' : '', st.dim ? 'ansi-dim' : '', st.i ? 'ansi-i' : '', st.u ? 'ansi-u' : ''].filter(Boolean).join(' ');
    return cls || st.rgb ? `<span${cls ? ` class="${cls}"` : ''}${st.rgb ? ` style="color:${st.rgb}"` : ''}>` : '';
  };
  const lines = String(text ?? '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\r\n/g, '\n').split('\n')
    .map(l => { const p = l.split('\r').filter(Boolean); return p.length ? p[p.length - 1] : ''; }); // a carriage return draws over the line
  const plain = lines.map(l => l.replace(/\x1b\[[0-9;?]*[@-~]/g, ''));
  const diff = opts.diff || plain.some(l => /^(@@ |diff --git )/.test(l));
  return lines.map((l, k) => {
    let out = '', inSpan = false, coloured = false;
    for (const part of l.split(/(\x1b\[[0-9;?]*[@-~])/)) {
      const m = /^\x1b\[([0-9;]*)m$/.exec(part);
      if (m) { sgr(m[1] === '' ? [0] : m[1].split(';').map(x => +x || 0)); coloured = true; if (inSpan) out += '</span>'; const o = open(); out += o; inSpan = !!o; continue; }
      if (/^\x1b/.test(part)) continue; // cursor moves, erases: nothing to show
      const t = part.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
      if (t && !inSpan && !out) { const o = open(); out += o; inSpan = !!o; }
      out += escHtml(t);
    }
    if (inSpan) out += '</span>';
    out = out.replace(/<span[^>]*><\/span>/g, '');
    if (!diff || coloured) return out;
    const p = plain[k], cls = /^(@@|\+\+\+ |--- |diff --git )/.test(p) ? 'd-hunk' : /^\+/.test(p) ? 'd-add' : /^-/.test(p) ? 'd-del' : '';
    return cls ? `<span class="${cls}">${out}</span>` : out;
  }).join('\n');
}
// The last n rows the CLI drew, as text; a row the terminal soft-wrapped joins the one before it when asked. Blank rows
// under them don't count: a fresh or short session draws at the top of a tall terminal, and its footer, menu or box
// sat above "the last n rows" (the mode chip went missing, a mode switch pressed Shift+Tab blind).
function bufferRows(buf, n, joinWrapped = false) {
  const rows = []; if (!buf) return rows;
  let end = buf.length; while (end > 0) { const l = buf.getLine(end - 1); if (l && l.translateToString(true).trim()) break; end--; }
  for (let y = Math.max(0, end - n); y < end; y++) { const l = buf.getLine(y); if (!l) continue; const t = l.translateToString(true); if (joinWrapped && l.isWrapped && rows.length) rows[rows.length - 1] += t; else rows.push(t); }
  return rows;
}
// The CLI working on a turn (not waiting on you, not idle).
const isWorkingStatus = (s) => /^(active|resuming|settling)$/.test(s || '');
// Arrow keys that move a CLI menu's selection by d rows.
const arrowKeys = (d) => Array(Math.abs(d)).fill(d > 0 ? '\x1b[B' : '\x1b[A');

// Undo a turn's edits: its Edit calls, newest first, each putting old_string back where new_string is. All or nothing:
// any edit that can't be put back exactly (its text changed since, or shows up twice) stops it, and nothing is written.
// files: path → content now. Returns { files } with the contents to write, or { error }.
function undoEdits(files, edits) {
  const out = new Map(files);
  for (const e of [...edits].reverse()) {
    let c = out.get(e.file); const name = baseName(e.file);
    if (c == null) return { error: `${name} is gone` };
    const n = e.new ? c.split(e.new).length - 1 : 0;
    if (!n) return { error: `${name} changed since` };
    if (n > 1 && !e.all) return { error: `${name}: the edit shows up ${n} times` };
    c = e.all ? c.split(e.new).join(e.old) : c.replace(e.new, () => e.old);
    out.set(e.file, c);
  }
  return { files: out };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { chatUrlRe, escHtml, termHtml, bufferRows, isWorkingStatus, arrowKeys, toolView, groupSummary, lineDiff, baseName, matchFiles, parseUnified, fileRefs, pathRef, dictJoin, wavBytes, liveReply, screenDialog, undoEdits };
