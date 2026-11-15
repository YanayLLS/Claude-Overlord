// Keeps a feature agent's edits on the feature's branch. When an agent working in a feature
// worktree edits a file in a repo's main checkout, its edit hook asks Overlord first; this
// decides whether to redirect it and where. Pure: main.js does the git work and the reply.
const path = require('path');

const norm = (p) => path.resolve(p).toLowerCase(); // Windows paths ignore case
const inside = (file, dir) => { const f = norm(file), d = norm(dir); return f === d || f.startsWith(d.endsWith(path.sep) ? d : d + path.sep); };

// file: the path being edited. cwd: the agent's folder. worktrees: settings.worktrees.
// repos: main checkouts Overlord knows. Returns null (let it through) or
// { feature, branch, repo, member (the feature's worktree of that repo, or null), rel }.
function planRedirect({ file, cwd, worktrees, repos }) {
  if (!file || !cwd) return null;
  const self = (worktrees || []).find(w => w.feature && norm(w.path) === norm(cwd));
  if (!self) return null;
  const mine = worktrees.filter(w => w.feature === self.feature);
  if (mine.some(w => inside(file, w.path))) return null;
  // Deepest repo that holds the file, so a repo nested in another wins.
  const repo = [...new Set([...(repos || []), ...worktrees.map(w => w.repo)])]
    .filter(r => r && inside(file, r))
    .sort((a, b) => norm(b).length - norm(a).length)[0];
  if (!repo) return null;
  const member = mine.find(w => norm(w.repo) === norm(repo)) || null;
  return { feature: self.feature, branch: self.branch, repo, member, rel: path.relative(path.resolve(repo), path.resolve(file)) }; // win32 path.relative ignores case
}

// The same guard for shell commands (Bash / PowerShell), which the edit hook can't see by path. Deliberately
// narrow so normal work never trips it: only a command that clearly CHANGES a repo's main checkout —
// a state-changing git command run there (cd <repo> ... / git -C <repo>), sed -i on a file there, or a
// > / >> redirect into a file there. Reading, git status/log/diff, copying out and running scripts pass.
const GIT_WRITE = '(?:commit|checkout|switch|reset|merge|rebase|pull|push|stash|add|rm|mv|restore|cherry-pick|revert|apply|am)';
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fwd = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
function planShellRedirect({ command, cwd, worktrees, repos }) {
  if (!command || !cwd) return null;
  const self = (worktrees || []).find(w => w.feature && norm(w.path) === norm(cwd));
  if (!self) return null;
  const mine = worktrees.filter(w => w.feature === self.feature);
  // One spelling to match against: forward slashes, Git Bash's /c/... as C:/...
  const cmd = fwd(command).replace(/(^|[\s"'=;&|(])\/([a-zA-Z])\//g, (_, pre, d) => `${pre}${d.toUpperCase()}:/`);
  const all = [...new Set([...(repos || []), ...worktrees.map(w => w.repo)])].filter(Boolean)
    .sort((a, b) => fwd(b).length - fwd(a).length);
  for (const repo of all) {
    const R = esc(fwd(repo)), at = String.raw`["']?${R}(?:/[^\s"';&|]*)?["']?`, into = String.raw`["']?${R}/`;
    const hit = [
      new RegExp(String.raw`\bcd\s+${at}\s*(?:&&|;|\n)[\s\S]*?\bgit\s+${GIT_WRITE}\b`, 'i'),
      new RegExp(String.raw`\bgit\s+-C\s+${at}\s+${GIT_WRITE}\b`, 'i'),
      new RegExp(String.raw`\bsed\s+(?:-[a-zA-Z]*i[a-zA-Z]*|--in-place)\b[^|;&]*${into}`, 'i'),
      new RegExp(String.raw`(?:^|[^0-9&>])>>?\s*${into}`, 'i'),
    ].some(re => re.test(cmd));
    if (!hit) continue;
    if (mine.some(w => inside(repo, w.path))) continue; // the feature's own worktree, not a main checkout
    return { feature: self.feature, branch: self.branch, repo, member: mine.find(w => norm(w.repo) === norm(repo)) || null };
  }
  return null;
}

module.exports = { planRedirect, planShellRedirect };
