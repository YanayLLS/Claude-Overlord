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
  const s = parts.join(', ');
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
  const files = []; let f = null, oldN = 0, newN = 0;
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('diff --git ')) { const m = / b\/(.+)$/.exec(line); f = { file: m ? m[1] : line.slice(11), add: 0, del: 0, created: false, deleted: false, rows: [] }; files.push(f); continue; }
    if (!f) continue;
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(line);
    if (line.startsWith('new file mode')) f.created = true;
    else if (line.startsWith('deleted file mode')) f.deleted = true;
    else if (h) { oldN = +h[1]; newN = +h[2]; f.rows.push({ t: '…', s: line.replace(/^(@@[^@]*@@).*$/, '$1') + (h[3] ? ' ' + h[3] : ''), n: newN }); }
    else if (/^(---|\+\+\+|index |similarity|rename |old mode|new mode|Binary)/.test(line)) continue;
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
// The last n rows of an xterm buffer as text; a row the terminal soft-wrapped joins the one before it when asked.
function bufferRows(buf, n, joinWrapped = false) {
  const rows = []; if (!buf) return rows;
  for (let y = Math.max(0, buf.length - n); y < buf.length; y++) { const l = buf.getLine(y); if (!l) continue; const t = l.translateToString(true); if (joinWrapped && l.isWrapped && rows.length) rows[rows.length - 1] += t; else rows.push(t); }
  return rows;
}
// The CLI working on a turn (not waiting on you, not idle).
const isWorkingStatus = (s) => /^(active|resuming|settling)$/.test(s || '');
// Arrow keys that move a CLI menu's selection by d rows.
const arrowKeys = (d) => Array(Math.abs(d)).fill(d > 0 ? '\x1b[B' : '\x1b[A');

if (typeof module !== 'undefined' && module.exports) module.exports = { chatUrlRe, escHtml, bufferRows, isWorkingStatus, arrowKeys, toolView, groupSummary, lineDiff, baseName, matchFiles, parseUnified, fileRefs, pathRef, dictJoin, liveReply, screenDialog };
