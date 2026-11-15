// Which Node a repo needs, and whether this machine has it. Read before making a worktree so a
// mismatch shows up front ("Needs Node 24") instead of as a failed install minutes later.
const fs = require('fs');
const path = require('path');

// Lowest major a semver-ish requirement accepts: ">=22", "^20.11", "24.22.2", "20.x", "^18 || >=22" -> 18.
function minMajor(req) {
  const majors = String(req || '').split('||').map(part => {
    const m = /(?:^|[\s>=^~v])(\d+)/.exec(part.trim().replace(/^[<]=?\s*\d[^\s]*\s*/, '')); // an upper bound alone says nothing
    return m ? Number(m[1]) : null;
  }).filter(n => n != null);
  return majors.length ? Math.min(...majors) : null;
}

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const lockCache = new Map(); // lock path -> { mtimeMs, hit }

// The strictest need found: .nvmrc / .node-version pins, package.json engines.node, and any locked
// package's engines.node (a dependency can need more than the repo declares). null when nothing says.
// Async: a lockfile is megabytes, read off the main thread's way; parsed once per change (mtime).
async function nodeRequirement(repo) {
  const found = [];
  for (const f of ['.nvmrc', '.node-version']) { const t = read(path.join(repo, f)); const n = t && minMajor(t.trim()); if (n) found.push({ major: n, source: f }); }
  const pkg = read(path.join(repo, 'package.json'));
  if (pkg) { try { const n = minMajor(((JSON.parse(pkg).engines) || {}).node); if (n) found.push({ major: n, source: 'package.json' }); } catch {} }
  const lockPath = path.join(repo, 'package-lock.json');
  const st = await fs.promises.stat(lockPath).catch(() => null);
  if (st) {
    let c = lockCache.get(lockPath);
    if (!c || c.mtimeMs !== st.mtimeMs) {
      let hit = null;
      try {
        for (const [k, v] of Object.entries(JSON.parse(await fs.promises.readFile(lockPath, 'utf8')).packages || {})) {
          const n = k && v && v.engines && minMajor(v.engines.node);
          if (n && (!hit || n > hit.major)) hit = { major: n, source: k.replace(/^.*node_modules\//, '') };
        }
      } catch {}
      c = { mtimeMs: st.mtimeMs, hit }; lockCache.set(lockPath, c);
    }
    if (c.hit) found.push(c.hit);
  }
  return found.reduce((best, f) => (!best || f.major > best.major ? f : best), null);
}

// installed: `node -v` output ("v20.20.0"), '' when node isn't found.
function checkNode(req, installed) {
  const have = /(\d+\.\d+\.\d+)/.exec(String(installed || ''));
  const v = have ? have[1] : null;
  if (!req) return { ok: true, need: null, have: v, source: null };
  return { ok: !!v && Number(v.split('.')[0]) >= req.major, need: req.major, have: v, source: req.source };
}

module.exports = { minMajor, nodeRequirement, checkNode };
