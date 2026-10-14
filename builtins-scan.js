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
  // some commands are declared in another shape the pattern misses (/model, /cost, /context…) — keep the hand-kept ones
  for (const fb of fallback) if (!scraped.has(fb.name)) out.push(fb);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Stream the binary (hundreds of MB) in chunks with an overlap so a command split across two chunks is still found.
function scanClaudeBinary(file) {
  return new Promise((resolve, reject) => {
    const found = new Map();
    let tail = '';
    fs.createReadStream(file, { encoding: 'latin1', highWaterMark: 8 << 20 })
      .on('data', (chunk) => { const s = tail + chunk; parseBuiltins(s, found); tail = s.slice(-600); })
      .on('end', () => resolve(found))
      .on('error', reject);
  });
}

// seen: { "type:name": firstSeenMs } (mutated). The very first run is a baseline: nothing is "new".
// Returns items with isNew for anything first seen within the last week.
function markNew(items, seen, now = Date.now()) {
  const baseline = Object.keys(seen).length === 0;
  return items.map(i => {
    const k = i.type + ':' + i.name;
    if (!(k in seen)) seen[k] = baseline ? 0 : now;
    return seen[k] && now - seen[k] < NEW_FOR_MS ? { ...i, isNew: true } : i;
  });
}

module.exports = { parseBuiltins, mergeBuiltins, scanClaudeBinary, markNew };
