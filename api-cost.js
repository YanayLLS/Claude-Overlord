// What the Claude Code transcripts would have cost at pay-per-token API list prices.
// Self-check: api-cost.test.js
const fs = require('fs');
const path = require('path');

// $ per million tokens: [model id pattern, input, output, cache read], first match wins.
// Cache writes are 1.25x input (5-min TTL) or 2x input (1-hour TTL).
// ponytail: hand-kept list prices (2026-09), add a row when a new model ships; unknown models cost $0.
const PRICES = [
  [/(fable|mythos)-5-1/, 10, 50, 0.25],
  [/fable|mythos/, 10, 50, 1],
  [/opus-5-5/, 4, 20, 0.2],
  [/opus-4(-1)?(-\d{8})?$|opus-4-1-/, 15, 75, 1.5], // Opus 4 / 4.1
  [/opus/, 5, 25, 0.5],
  [/sonnet-5/, 2, 10, 0.2],
  [/sonnet/, 3, 15, 0.3],
  [/haiku-4/, 1, 5, 0.1],
  [/haiku-3-5/, 0.8, 4, 0.08],
  [/haiku/, 0.25, 1.25, 0.03],
];

function priceFor(model) {
  const row = PRICES.find(r => r[0].test(model || ''));
  return row ? { in: row[1], out: row[2], read: row[3] } : null;
}

// Dollars for one API response's usage block.
function usageCost(u, model) {
  const p = priceFor(model);
  if (!p || !u) return 0;
  const cc = u.cache_creation;
  const writes = cc
    ? (cc.ephemeral_5m_input_tokens || 0) * 1.25 + (cc.ephemeral_1h_input_tokens || 0) * 2
    : (u.cache_creation_input_tokens || 0) * 1.25;
  const usd = ((u.input_tokens || 0) * p.in + writes * p.in
    + (u.cache_read_input_tokens || 0) * p.read + (u.output_tokens || 0) * p.out) / 1e6;
  return u.speed === 'fast' ? usd * 2 : usd; // ponytail: fast mode = 2x, true for Opus 5 / 5.5
}

// One transcript line -> { k, t, m, c } or null. k dedups: a response is logged once per content
// block, and resumed sessions copy earlier lines into the new file.
function parseLine(line) {
  if (line.indexOf('"usage"') < 0 || line.indexOf('"assistant"') < 0) return null;
  let j; try { j = JSON.parse(line); } catch { return null; }
  const msg = j.message;
  if (j.type !== 'assistant' || !msg || !msg.usage) return null;
  const t = Date.parse(j.timestamp);
  if (isNaN(t)) return null;
  return { k: (msg.id || '') + ':' + (j.requestId || j.uuid), t, m: msg.model || '', c: usageCost(msg.usage, msg.model) };
}

// Per-file cache: only bytes appended since the last scan are read. { size, rows }
const files = new Map();
const KEEP_MS = 15 * 86400000; // last week's whole window, so it can be compared with this one

function jsonlFiles(dir, since, out) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) jsonlFiles(p, since, out);
    else if (e.name.endsWith('.jsonl')) { try { const st = fs.statSync(p); if (st.mtimeMs >= since) out.push([p, st.size]); } catch {} }
  }
  return out;
}

// The per-file cache on disk too: without it every app start re-read 15 days of transcripts (16 GB on a busy machine)
// and held the main process for minutes. With it a start reads only what was written since the last scan.
let cacheLoaded = false;
async function loadCache(cachePath) {
  if (cacheLoaded || !cachePath) return; cacheLoaded = true;
  try { const j = JSON.parse(await fs.promises.readFile(cachePath, 'utf8')); if (j && j.v === 1) for (const [p, r] of Object.entries(j.files || {})) if (!files.has(p)) files.set(p, { size: r.s, rows: r.r.map(([k, t, m, c]) => ({ k, t, m, c })) }); } catch {}
}
async function saveCache(cachePath) {
  if (!cachePath) return;
  const out = { v: 1, files: {} }; for (const [p, r] of files) out.files[p] = { s: r.size, r: r.rows.map(x => [x.k, x.t, x.m, x.c]) };
  try { await fs.promises.mkdir(path.dirname(cachePath), { recursive: true }); await fs.promises.writeFile(cachePath + '.tmp', JSON.stringify(out)); await fs.promises.rename(cachePath + '.tmp', cachePath); } catch {}
}

// Reads new transcript lines under root. Async, and it hands the main loop back every ~8 ms, so even a first full scan
// never stalls the app. cachePath (optional): where the per-file cache lives between runs.
async function scanCosts(root, now, cachePath) {
  await loadCache(cachePath);
  const since = now - KEEP_MS; let changed = false;
  const found = jsonlFiles(root, since, []);
  const keep = new Set(found.map(([p]) => p));
  for (const p of files.keys()) if (!keep.has(p)) files.delete(p); // transcripts that aged out of the window (rows were filtered, entries never were)
  for (const [p, size] of found) {
    let rec = files.get(p);
    if (!rec || size < rec.size) { rec = { size: 0, rows: [] }; files.set(p, rec); }
    if (size === rec.size) continue;
    let buf;
    try {
      const fh = await fs.promises.open(p, 'r');
      try { buf = Buffer.alloc(size - rec.size); await fh.read(buf, 0, buf.length, rec.size); } finally { await fh.close(); }
    } catch { continue; }
    const end = buf.lastIndexOf(10); // a half-written last line waits for the next scan
    if (end < 0) continue;
    let at = 0, mark = Date.now();
    while (at < end) { let nl = buf.indexOf(10, at); if (nl < 0 || nl > end) nl = end; const r = parseLine(buf.toString('utf8', at, nl)); if (r) rec.rows.push(r); at = nl + 1; if (Date.now() - mark > 8) { await new Promise(res => setImmediate(res)); mark = Date.now(); } }
    rec.size += end + 1; changed = true;
    rec.rows = rec.rows.filter(r => r.t >= since);
  }
  if (changed) await saveCache(cachePath);
}

// Total $ for responses in [start, end], optionally only models whose id contains `model`.
function sumCost(start, end, model) {
  const seen = new Set();
  let usd = 0;
  for (const rec of files.values()) for (const r of rec.rows) {
    if (r.t < start || r.t > end || (model && !r.m.includes(model)) || seen.has(r.k)) continue;
    seen.add(r.k); usd += r.c;
  }
  return usd;
}

// $ per window [{ start, end, model }] over every transcript, however old, in one streaming pass.
// For the one-time backfill of history older than KEEP_MS; keeps no rows, only the dedup keys.
async function windowCosts(root, wins) {
  const readline = require('readline');
  const usd = wins.map(() => 0), seen = new Set();
  const since = Math.min(...wins.map(w => w.start)), until = Math.max(...wins.map(w => w.end));
  for (const [p] of jsonlFiles(root, since, [])) {
    const rl = readline.createInterface({ input: fs.createReadStream(p), crlfDelay: Infinity });
    for await (const line of rl) {
      const r = parseLine(line);
      if (!r || r.t < since || r.t > until || seen.has(r.k)) continue;
      seen.add(r.k);
      wins.forEach((w, i) => { if (r.t >= w.start && r.t <= w.end && (!w.model || r.m.includes(w.model))) usd[i] += r.c; });
    }
  }
  return usd;
}

module.exports = { KEEP_MS, windowCosts, priceFor, usageCost, parseLine, scanCosts, sumCost, _files: files, _resetCache: () => { cacheLoaded = false; } };
