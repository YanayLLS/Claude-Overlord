// "Convert to feature" for a plain agent: find the work it did in each repo's checkout, copy that
// work into a fresh feature worktree per repo (branched from the checkout's HEAD, so it applies
// cleanly and its commits come along), then take it out of the shared checkout. Only files this agent
// edited move; files another agent edited too are copied but stay in the checkout as well.
// git is injected (worktree.js's git(cwd, args) -> stdout) so the tests run it on real temp repos.
const fs = require('fs');
const path = require('path');
const os = require('os');

const norm = (p) => path.resolve(p).toLowerCase(); // Windows paths ignore case
const inside = (file, dir) => { const f = norm(file), d = norm(dir); return f === d || f.startsWith(d.endsWith(path.sep) ? d : d + path.sep); };
const relOf = (root, f) => path.relative(path.resolve(root), path.resolve(f)).split(path.sep).join('/');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// Absolute paths an agent edited with its file tools, from transcript text (its JSONL, subagents' appended).
// ponytail: shell edits (sed, scripts) are invisible here; the dialog lists what will move so a miss shows.
function editedFiles(jsonl) {
  const out = new Map();
  for (const line of String(jsonl || '').split('\n')) {
    if (!line.includes('"tool_use"')) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    const content = r && r.message && Array.isArray(r.message.content) ? r.message.content : [];
    for (const c of content) {
      if (!c || c.type !== 'tool_use' || !EDIT_TOOLS.has(c.name) || !c.input) continue;
      const f = c.input.file_path || c.input.notebook_path;
      if (typeof f === 'string' && path.isAbsolute(f) && !out.has(norm(f))) out.set(norm(f), path.resolve(f));
    }
  }
  return [...out.values()];
}

// `git status --porcelain=v1 -z --untracked-files=all` -> repo-relative paths, forward slashes.
function parseStatus(out) {
  const tracked = [], untracked = [];
  const parts = String(out || '').split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2), p = e.slice(3);
    if (xy === '??') untracked.push(p);
    else if (xy !== '!!') { tracked.push(p); if (xy[0] === 'R' || xy[0] === 'C') i++; } // the next entry is the rename's source
  }
  return { tracked, untracked };
}

// What moves per repo. repos: [{ root, tracked, untracked }] (from repoState). files: the agent's edits.
// others: files other agents edited. A file belongs to the deepest repo holding it (nested repos).
function planMove({ files, repos, others }) {
  const otherSet = new Set((others || []).map(norm));
  const owner = (f) => repos.filter(r => inside(f, r.root)).sort((a, b) => norm(b.root).length - norm(a.root).length)[0];
  return repos.map(r => {
    const mine = new Set(files.filter(f => owner(f) === r).map(f => relOf(r.root, f).toLowerCase()));
    const pick = (list) => list.filter(p => mine.has(p.toLowerCase()));
    const tracked = pick(r.tracked), untracked = pick(r.untracked);
    const shared = [...tracked, ...untracked].filter(p => otherSet.has(norm(path.join(r.root, p))));
    return { ...r, tracked, untracked, shared, touched: mine.size };
  });
}

// Where the agent's folder lands: the same spot inside its repo's new worktree.
function newCwd(cwd, moves) {
  const m = moves.filter(x => inside(cwd, x.root)).sort((a, b) => norm(b.root).length - norm(a.root).length)[0];
  if (m) return path.join(m.dest, path.relative(path.resolve(m.root), path.resolve(cwd)));
  return null;
}

// One checkout's facts: top folder, HEAD, branch, main checkout (git lists it first) and what is changed.
async function repoState(git, dir) {
  const root = path.resolve((await git(dir, ['rev-parse', '--show-toplevel'])).trim());
  const [head, branch, status, list] = await Promise.all([
    git(root, ['rev-parse', 'HEAD']).then(s => s.trim()),
    git(root, ['branch', '--show-current']).then(s => s.trim()).catch(() => ''),
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    git(root, ['worktree', 'list', '--porcelain']),
  ]);
  const main = path.resolve(((/^worktree (.+)$/m.exec(list) || [])[1] || root).trim());
  return { root, head, branch, main, ...parseStatus(status) };
}

const chunks = (a, n = 150) => { const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; }; // Windows command-line limit

// Copy a repo's moving files from the checkout into the worktree at dest (same HEAD, so the patch applies).
async function copyWork(git, root, dest, tracked, untracked) {
  let patch = '';
  for (const c of chunks(tracked)) patch += await git(root, ['diff', 'HEAD', '--binary', '--', ...c]);
  if (patch.trim()) {
    const f = path.join(os.tmpdir(), `overlord-move-${process.pid}-${Date.now()}.patch`);
    fs.writeFileSync(f, patch);
    try { await git(dest, ['apply', '--binary', '--whitespace=nowarn', f]); } finally { try { fs.unlinkSync(f); } catch {} }
  }
  for (const p of untracked) {
    const to = path.join(dest, p);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(root, p), to);
  }
}

// Take the moved files out of the checkout: tracked back to HEAD (a staged new file goes away), new files deleted.
async function cleanSource(git, root, tracked, untracked) {
  for (const c of chunks(tracked)) await git(root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...c]);
  for (const p of untracked) { try { fs.unlinkSync(path.join(root, p)); } catch {} }
}

// The whole move, all or nothing. moves: planMove output. makeWorktree(move) -> dest folder (branched at
// move.head); dropWorktree(move, dest) undoes one. Nothing in a checkout changes until every repo's copy
// worked. Returns moves with dest set.
async function convert({ git, moves, makeWorktree, dropWorktree }) {
  const made = [];
  try {
    for (const m of moves) {
      const dest = await makeWorktree(m);
      made.push({ ...m, dest });
      await copyWork(git, m.root, dest, m.tracked, m.untracked);
    }
  } catch (e) {
    for (const m of made) await Promise.resolve(dropWorktree(m, m.dest)).catch(() => {});
    throw e;
  }
  for (const m of made) {
    const keep = new Set(m.shared.map(p => p.toLowerCase()));
    await cleanSource(git, m.root, m.tracked.filter(p => !keep.has(p.toLowerCase())), m.untracked.filter(p => !keep.has(p.toLowerCase())));
  }
  return made;
}

module.exports = { editedFiles, parseStatus, planMove, newCwd, repoState, copyWork, cleanSource, convert };
