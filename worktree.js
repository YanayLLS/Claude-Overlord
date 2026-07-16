// Git worktree helpers for Overlord.
// Pure git/fs operations — no Electron, no shared app state. main.js owns the
// IPC glue, persistence, and dev-server lifecycle; this module just does the work.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const WT_ROOT = path.join(os.homedir(), '.overlord', 'worktrees');
// No shell: pass argv directly so spaces in branch names / worktree paths aren't split
// into extra args. execFile resolves `git` from PATH on Windows without a shell.
const GIT_OPTS = { windowsHide: true, maxBuffer: 16 * 1024 * 1024 };

// A git-ref-safe branch name. Git forbids spaces and ~^:?*[\ in ref names, so a feature
// display name like "Self service" becomes the branch "Self-service".
function safeBranch(name) {
  return String(name).trim()
    .replace(/[\x00-\x1f\x7f ~^:?*\[\\]+/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/^[-/.]+|[-/.]+$/g, '')
    .replace(/-{2,}/g, '-') || 'wt';
}

// Filesystem-safe branch slug: feat/login -> feat-login. Keeps it readable and
// collision-free enough for a per-repo folder (two branches differing only by a
// slashed segment would still map distinctly).
function slug(branch) {
  return String(branch).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'wt';
}

function worktreePath(repoPath, branch) {
  return path.join(WT_ROOT, path.basename(repoPath), slug(branch));
}

function git(repo, args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', repo, ...args], { ...GIT_OPTS, timeout }, (err, stdout, stderr) => {
      if (err) { err.message = (stderr || err.message || '').trim() || err.message; return reject(err); }
      resolve(String(stdout));
    });
  });
}

// Remote branches for the base-branch picker. Strips the "origin/" prefix and the
// symbolic origin/HEAD entry. Falls back to local branches if there's no remote.
async function listBranches(repo) {
  try {
    const out = await git(repo, ['branch', '-r', '--format=%(refname:short)'], 20000);
    const remote = out.split('\n').map(s => s.trim())
      .filter(b => b && !b.includes('->'))
      .map(b => b.replace(/^origin\//, ''));
    if (remote.length) return [...new Set(remote)].sort();
  } catch {}
  const local = await git(repo, ['branch', '--format=%(refname:short)'], 20000);
  return [...new Set(local.split('\n').map(s => s.trim()).filter(Boolean))].sort();
}

// Copy gitignored-but-load-bearing files (certs, .env) from the main checkout into
// a fresh worktree, which git never populates. Missing entries are skipped, not fatal.
function copySeedFiles(repo, dest, seedFiles) {
  const copied = [];
  for (const rel of (seedFiles || [])) {
    const src = path.join(repo, rel);
    const dst = path.join(dest, rel);
    try {
      if (!fs.existsSync(src)) continue;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.cpSync(src, dst, { recursive: true });
      copied.push(rel);
    } catch {}
  }
  return copied;
}

// Gitignored-but-needed-to-run files a fresh worktree lacks: any top-level .env* file
// and a .certs dir (mkcert TLS for lvh.me). Copying these makes the dev server runnable.
function detectSeedFiles(dir) {
  const out = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      if (/^\.env(\.|$)/.test(name) && !name.endsWith('.example')) out.push(name);
    }
  } catch {}
  if (fs.existsSync(path.join(dir, '.certs'))) out.push('.certs');
  return out;
}

function detectPackageManager(dir) {
  if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(dir, 'package-lock.json'))) return 'npm';
  if (fs.existsSync(path.join(dir, 'package.json'))) return 'npm';
  return null;
}

// Best-guess dev command + url template, shown prefilled in the config dialog so the
// user confirms rather than types from scratch. Detection order mirrors how these repos
// actually launch: a start.bat wins, then docker compose, then a vite/next dev script.
function detectDevCommand(dir) {
  // lvh.me + mkcert repos keep a .certs dir and serve https on lvh.me.
  const urlTemplate = fs.existsSync(path.join(dir, '.certs')) ? 'https://lvh.me:{port}' : 'http://localhost:{port}';
  const guess = { devCommand: '', urlTemplate, seedFiles: detectSeedFiles(dir) };
  const runner = { pnpm: 'pnpm', yarn: 'yarn', npm: 'npm run' }[detectPackageManager(dir)] || 'npm run';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const scripts = pkg.scripts || {};
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    // Prefer a full local-stack script (these repos read PORT); fall back to plain dev/start.
    const named = ['dev:local:remote-back', 'dev:local', 'dev', 'start'].find(s => scripts[s]);
    if (named) {
      const val = scripts[named] || '';
      // Only a bare `vite` script needs the --port flag; wrappers (concurrently, custom
      // orchestrators) read PORT from the env we inject, so leave them alone.
      const bareVite = /^vite(\s|$)/.test(val);
      guess.devCommand = bareVite ? `${runner} ${named} -- --port {port}` : `${runner} ${named}`;
      // Concurrently-wrapped dev with a separate vite `client`: the API binds base and the
      // vite client (the openable app) binds base+1 — so the browser link is base+1.
      if (/concurrently/.test(val) && /^(cross-env\s+)?vite(\s|$)/.test(scripts.client || '')) {
        guess.urlTemplate = guess.urlTemplate.replace('{port}', '{port+1}');
      }
      return guess;
    }
  } catch {}
  if (fs.existsSync(path.join(dir, 'start.bat'))) { guess.devCommand = 'start.bat'; return guess; }
  const compose = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']
    .find(f => fs.existsSync(path.join(dir, f)));
  if (compose) guess.devCommand = `docker compose -f ${compose} up`;
  return guess;
}

// Returns ref if it exists, else null. No ^{commit} peel — that caret is the cmd.exe
// escape char and gets eaten when git runs under shell:true on Windows.
async function resolveRef(repo, ref) {
  try { await git(repo, ['rev-parse', '--verify', '--quiet', ref], 15000); return ref; }
  catch { return null; }
}

// git worktree add -b <branch> <dest> origin/<base>. Fetches first so <base> is fresh.
// If the branch already exists locally, checks it out into the worktree instead of -b.
async function createWorktree({ repo, branch, base }) {
  const dest = worktreePath(repo, branch);
  if (fs.existsSync(dest)) throw new Error(`Worktree path already exists: ${dest}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try { await git(repo, ['fetch', 'origin', base], 60000); } catch {}

  let branchExists = false;
  try { await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], 15000); branchExists = true; } catch {}

  // Prefer the LOCAL branch (has the user's latest commits, which may not be pushed) over
  // origin/<base>; fall back to the base verbatim if it's already a full ref. Forking from
  // origin would silently drop local-only commits — the exact trap that ran worktrees on
  // stale hardcoded ports.
  let startPoint = base;
  if (!base.includes('/')) {
    startPoint = await resolveRef(repo, base) || await resolveRef(repo, `origin/${base}`) || base;
  } else {
    startPoint = await resolveRef(repo, base) || base;
  }
  const args = branchExists
    ? ['worktree', 'add', dest, branch]
    : ['worktree', 'add', '-b', branch, dest, startPoint];
  await git(repo, args);
  return dest;
}

async function removeWorktree({ repo, dest, branch, deleteBranch }) {
  try { await git(repo, ['worktree', 'remove', '--force', dest], 60000); }
  catch (e) {
    // Path already gone on disk — prune the stale registration so git isn't left confused.
    await git(repo, ['worktree', 'prune'], 20000).catch(() => {});
    if (fs.existsSync(dest)) throw e;
  }
  if (deleteBranch && branch) {
    await git(repo, ['branch', '-D', branch], 20000).catch(() => {});
  }
}

async function repoRoot(dir) {
  const out = await git(dir, ['rev-parse', '--show-toplevel'], 15000);
  return out.trim();
}

module.exports = {
  WT_ROOT, slug, safeBranch, worktreePath, listBranches, copySeedFiles, detectSeedFiles,
  detectPackageManager, detectDevCommand, createWorktree, removeWorktree, repoRoot,
};
