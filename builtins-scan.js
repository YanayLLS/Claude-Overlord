// Claude Code's real slash commands, read out of the installed claude binary (its bundled JS keeps each command as
// `type:"local",name:"x",description:"…"`), plus "new" tracking for everything the picker lists.
// Self-check: builtins-scan.test.js

const fs = require('fs');

const CMD_RE = /type:"(?:local|local-jsx|prompt)",name:"([a-z][a-z0-9-]*)"(?:,description:"((?:[^"\\]|\\.){0,300})")?/g;
// Internal, account-specific or gone — never something to pick.
const SKIP = new Set(['heapdump', 'pro-trial-expired', 'rate-limit-options', 'workflow-launch-exec', 'install', 'stickers', 'upgrade', 'logout', 'design-consent', 'design-revoke', 'design-login', 'setup-bedrock', 'setup-vertex']);
const GONE = /^\((?:removed|deprecated)\)|^Renamed to /i;
const NEW_FOR_MS = 7 * 24 * 3600 * 1000;

// Binary text → Map name → description ('' when the bundle computes it at runtime).
function parseBuiltins(text, into = new Map()) {
  for (const m of String(text).matchAll(CMD_RE)) {
    const desc = (m[2] || '').replace(/\\(.)/g, '$1');
    if (!into.has(m[1]) || (!into.get(m[1]) && desc)) into.set(m[1], desc);
  }
  return into;
}

// Scraped names win; the hand-kept list fills in descriptions/hints the bundle computes at runtime, and covers
// a Claude build whose format no longer matches (nothing scraped → the hand-kept list alone).
function mergeBuiltins(scraped, fallback) {
  if (!scraped || scraped.size < 10) return fallback;
  const byName = new Map(fallback.map(b => [b.name, b]));
  const out = [];
  for (const [name, desc] of scraped) {
    if (SKIP.has(name) || GONE.test(desc)) continue;
    const fb = byName.get(name);
    out.push({ ...(fb || fallback[0]), name, desc: desc || fb?.desc || '', hint: fb?.hint, insert: `/${name} ` });
  }
  // some commands are declared in another shape the pattern misses (/model, /context…) — keep a hand-kept one while the
  // binary still names it anywhere (Claude removed /vim and /bashes; they must not linger)
  for (const fb of fallback) if (!scraped.has(fb.name) && (!scraped.names || scraped.names.has(fb.name))) out.push(fb);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Stream the binary (hundreds of MB) in chunks with an overlap so a command split across two chunks is still found.
function scanClaudeBinary(file) {
  return new Promise((resolve, reject) => {
    const found = new Map(), names = new Set();
    found.names = names; // every name:"x" in the bundle — tells a hand-kept command that still exists from a removed one
    let tail = '';
    fs.createReadStream(file, { encoding: 'latin1', highWaterMark: 8 << 20 })
      .on('data', (chunk) => { const s = tail + chunk; parseBuiltins(s, found); for (const m of s.matchAll(/name:"([a-z][a-z0-9-]*)"/g)) names.add(m[1]); tail = s.slice(-600); })
      .on('end', () => resolve(found))
      .on('error', reject);
  });
}

// Claude Code's CHANGELOG.md (newest version first) → Map name → the oldest version that mentions `/name`.
// The first mention is when it shipped: a command can't be written about before it exists.
function parseChangelog(md, names) {
  const want = new Set(names), out = new Map();
  let ver = null;
  for (const line of String(md || '').split('\n')) {
    const h = /^##\s+v?(\d+\.\d+\.\d+)/.exec(line);
    if (h) { ver = h[1]; continue; }
    if (!ver || !line.includes('`/')) continue;
    for (const m of line.matchAll(/`\/([a-z][a-z0-9-]*)(?![a-z0-9-])/g)) if (want.has(m[1])) out.set(m[1], ver);
  }
  return out;
}

// Stamp items with the Claude version that added them and that version's npm release date.
function stampSince(items, md, npmTimes) {
  const since = parseChangelog(md, items.map(i => i.name));
  return items.map(i => {
    const v = since.get(i.name), t = v && Date.parse((npmTimes || {})[v]);
    return v ? { ...i, since: v, ...(t && { addedAt: t }) } : i;
  });
}

// seen: { "type:name": firstSeenMs } (mutated). The first run is a baseline: nothing is "new". A repo's own items are
// keyed and baselined per repo (cwd), so opening the picker in another repo doesn't flag all its skills as new.
// Returns items with addedAt (the Claude release that shipped it, else when the picker first saw it; 0 = there
// before tracking began) and isNew for anything added within the last week.
function markNew(items, seen, now = Date.now(), cwd = '') {
  const first = Object.keys(seen).length === 0, scope = '@' + cwd, repoBaseline = !(scope in seen);
  seen[scope] = 1;
  return items.map(i => {
    const repo = i.origin === 'repo', k = (repo ? cwd + '|' : '') + i.type + ':' + i.name;
    if (!(k in seen)) seen[k] = first || (repo && repoBaseline) ? 0 : now;
    const at = i.addedAt || seen[k];
    return { ...i, addedAt: at, ...(at && now - at < NEW_FOR_MS && { isNew: true }) };
  });
}

module.exports = { parseBuiltins, mergeBuiltins, scanClaudeBinary, parseChangelog, stampSince, markNew };
