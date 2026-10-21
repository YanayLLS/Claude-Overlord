// Markdown documents opened in Overlord (double-click an .md, "Open with", drag, or a link in
// another doc). Pure helpers shared by main (docs-main.js) and the page (docs-ui.js):
// which launch args are documents, how a doc is titled, where its links and images point.

const MD_RE = /\.(?:md|markdown|mdown|mkd)$/i;

// Launch args that are markdown files, resolved against the launching shell's cwd.
// Electron's own argv (exe, app dir, --flags) never ends in .md, so a suffix test is enough.
function mdArgs(argv, cwd) {
  const out = [];
  for (const raw of argv || []) {
    const a = String(raw || '').replace(/^"|"$/g, '');
    if (!a || a.startsWith('-') || !MD_RE.test(a)) continue;
    out.push(absolutePath(a, cwd));
  }
  return out;
}

function isWinAbs(p) { return /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\/.test(p); }
function isAbs(p) { return p.startsWith('/') || isWinAbs(p); }
function absolutePath(p, cwd) { return isAbs(p) ? normalizePath(p) : joinPath(cwd || '', p); }

// Resolve `rel` against `dir` with `.`/`..` folded. Keeps the separator style of `dir`
// (backslashes on Windows paths) so what we send to fs and what we show the user match.
function joinPath(dir, rel) {
  if (isAbs(rel)) return normalizePath(rel);
  const win = isWinAbs(dir) || dir.includes('\\');
  return normalizePath((dir.replace(/[\\/]+$/, '') + (win ? '\\' : '/') + rel), win);
}
function normalizePath(p, win) {
  if (win === undefined) win = isWinAbs(p) || (p.includes('\\') && !p.includes('/'));
  const sep = win ? '\\' : '/';
  const parts = p.split(/[\\/]+/);
  const head = win ? parts.shift() : (p.startsWith('/') ? '' : null);
  const out = [];
  for (const seg of parts) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (out.length) out.pop(); continue; }
    out.push(seg);
  }
  if (win) return head + sep + out.join(sep);
  return (head === '' ? '/' : '') + out.join(sep);
}
function dirOf(p) { const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')); return i < 0 ? '' : p.slice(0, i); }
function baseOf(p) { const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')); return i < 0 ? p : p.slice(i + 1); }

// The roster shows the first H1 (or setext title) when there is one, else the file name.
function docTitle(text, filePath) {
  const body = splitFrontMatter(text || '').body;
  const m = body.match(/^[ \t]{0,3}#[ \t]+(.+?)[ \t]*#*[ \t]*$/m) || body.match(/^[ \t]{0,3}(\S.*)\r?\n[ \t]{0,3}=+[ \t]*$/m);
  const t = m ? m[1].replace(/[*_`]/g, '').trim() : '';
  return t || baseOf(filePath || '').replace(MD_RE, '') || 'Untitled';
}

// YAML front matter at the top: "---\nkey: value\n---". Shown as a small key/value table, not raw.
function splitFrontMatter(text) {
  const m = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { meta: null, body: text };
  const meta = [];
  for (const line of (m[1] || '').split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) meta.push([kv[1], kv[2].replace(/^["']|["']$/g, '')]);
    else if (meta.length && /^\s+\S/.test(line)) meta[meta.length - 1][1] += (meta[meta.length - 1][1] ? ' ' : '') + line.trim().replace(/^-\s*/, '');
  }
  return { meta: meta.length ? meta : null, body: text.slice(m[0].length) };
}

// GitHub-style heading ids, so "[see below](#my-heading)" lands where it does on github.com.
function slug(text, seen) {
  let s = String(text || '').toLowerCase().trim()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-');
  if (!s) s = 'section';
  if (seen) { const n = seen.get(s) || 0; seen.set(s, n + 1); if (n) s = `${s}-${n}`; }
  return s;
}

// What a click on a link in a document should do.
//   anchor   → scroll to a heading in this doc
//   external → the system browser
//   doc      → open another markdown file in Overlord (relative or absolute)
//   file     → hand any other local file to the OS
function classifyHref(href, docPath) {
  const h = String(href || '').trim();
  if (!h) return { kind: 'none' };
  if (h.startsWith('#')) return { kind: 'anchor', id: decodeURIComponent(h.slice(1)) };
  if (/^(?:https?|mailto|tel):/i.test(h)) return { kind: 'external', url: h };
  let p = h;
  if (/^file:\/\//i.test(p)) { p = decodeURIComponent(p.replace(/^file:\/\/\/?/i, '')); if (!isAbs(p) && !isWinAbs(p)) p = '/' + p; }
  if (/^[a-z][a-z0-9+.-]*:/i.test(p) && !isWinAbs(p)) return { kind: 'external', url: h };
  const hashAt = p.indexOf('#'); const hash = hashAt >= 0 ? decodeURIComponent(p.slice(hashAt + 1)) : '';
  if (hashAt >= 0) p = p.slice(0, hashAt);
  p = decodeURIComponent(p.split('?')[0]);
  if (!p) return { kind: 'anchor', id: hash };
  const abs = isAbs(p) ? normalizePath(p) : joinPath(dirOf(docPath || ''), p);
  return MD_RE.test(abs) ? { kind: 'doc', path: abs, hash } : { kind: 'file', path: abs };
}

// Relative image sources become file:// URLs next to the document; everything else is left alone.
function assetUrl(src, docPath) {
  const s = String(src || '').trim();
  if (!s || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(s)) return s;
  const abs = isAbs(s) ? normalizePath(s) : joinPath(dirOf(docPath || ''), s);
  return 'file:///' + encodeURI(abs.replace(/\\/g, '/').replace(/^\/+/, '')).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

// Roster order after opening `p`: an already-open doc keeps its place, a new one goes on top.
function withDoc(order, p) { return order.includes(p) ? order.slice() : [p, ...order]; }
function withoutDoc(order, p) { return order.filter(x => x !== p); }
// The doc to select after closing `p` from `order`: its neighbour below, else above, else none.
function nextAfterClose(order, p) {
  const i = order.indexOf(p); if (i < 0) return null;
  return order[i + 1] || order[i - 1] || null;
}

// Task-list markers in source order, skipping fenced code: "- [ ] x", "* [x] y", "1. [ ] z", also
// inside blockquotes. The n-th rendered checkbox is the n-th of these (marked renders in order).
const TASK_RE = /^([ \t]*(?:>[ \t]*)*(?:[-*+]|\d+[.)])[ \t]+)\[( |x|X)\](?=[ \t]|\r?$)/;
function toggleTask(text, n, checked) {
  const lines = String(text || '').split('\n');
  let fence = null, k = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = /^[ \t]*(?:>[ \t]*)*(`{3,}|~{3,})/.exec(line);
    if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = null; continue; }
    if (fence) continue;
    const m = TASK_RE.exec(line);
    if (!m) continue;
    if (k++ !== n) continue;
    lines[i] = m[1] + '[' + (checked ? 'x' : ' ') + ']' + line.slice(m[0].length);
    return lines.join('\n');
  }
  return null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MD_RE, mdArgs, joinPath, normalizePath, dirOf, baseOf, docTitle, splitFrontMatter, slug, classifyHref, assetUrl, withDoc, withoutDoc, nextAfterClose, toggleTask };
}
