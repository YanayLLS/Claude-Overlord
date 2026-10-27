// Chat view helpers with no DOM: how a tool call reads ("Ran git status"), what a run of calls sums up to
// ("Ran 2 commands, read 3 files"), and an edit's line diff. Page globals, and module.exports for the tests.

const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
const hostOf = (u) => { try { return new URL(u).host; } catch { return u || ''; } };

// { kind, verb, target, mono }: kind picks the icon and how the summary counts it; target is shown mono when it's code.
function toolView(ev, running) {
  const a = ev.args || {}, n = ev.name || '';
  const v = (done, now) => running ? now : done;
  switch (n) {
    case 'Bash': case 'PowerShell': return { kind: 'cmd', verb: v('Ran', 'Running'), target: a.command || a.description || '', mono: true };
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
    else if (h) { oldN = +h[1]; newN = +h[2]; f.rows.push({ t: '…', s: h[3] || '', n: newN }); }
    else if (/^(---|\+\+\+|index |similarity|rename |old mode|new mode|Binary)/.test(line)) continue;
    else if (line[0] === '+') { f.rows.push({ t: '+', s: line.slice(1), n: newN++ }); f.add++; }
    else if (line[0] === '-') { f.rows.push({ t: '-', s: line.slice(1), n: oldN++ }); f.del++; }
    else if (line[0] === ' ') { f.rows.push({ t: ' ', s: line.slice(1), n: newN++ }); oldN++; }
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

if (typeof module !== 'undefined' && module.exports) module.exports = { toolView, groupSummary, lineDiff, baseName, matchFiles, parseUnified, fileRefs };
