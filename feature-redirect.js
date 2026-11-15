// Keeps a feature agent's edits on the feature's branch. When an agent working in a feature
// worktree edits a file in a repo's main checkout, its edit hook asks Overlord first; this
// decides whether to redirect it and where. Pure: main.js does the git work and the reply.
const path = require('path');

const norm = (p) => path.resolve(p).toLowerCase(); // Windows paths ignore case
const inside = (file, dir) => { const f = norm(file), d = norm(dir); return f === d || f.startsWith(d.endsWith(path.sep) ? d : d + path.sep); };

// file: the path being edited. cwd: the agent's folder. worktrees: settings.worktrees.
// repos: main checkouts Overlord knows. Returns null (let it through) or
// { feature, branch, repo, member (the feature's worktree of that repo, or null), rel }.
// Main checkouts worth guarding: never one of the feature's own worktrees, nor a folder that holds them
// (a home folder listed as a project would otherwise claim every write under ~/.overlord or Temp).
function candidates(repos, worktrees, mine) {
  return [...new Set([...(repos || []), ...worktrees.map(w => w.repo)])]
    .filter(r => r && !mine.some(w => inside(w.path, r) || inside(r, w.path)));
}

function planRedirect({ file, cwd, worktrees, repos }) {
  if (!file || !cwd) return null;
  const self = (worktrees || []).find(w => w.feature && norm(w.path) === norm(cwd));
  if (!self) return null;
  const mine = worktrees.filter(w => w.feature === self.feature);
  if (mine.some(w => inside(file, w.path))) return null;
  // Deepest repo that holds the file, so a repo nested in another wins.
  const repo = candidates(repos, worktrees, mine)
    .filter(r => inside(file, r))
    .sort((a, b) => norm(b).length - norm(a).length)[0];
  if (!repo) return null;
  const member = mine.find(w => norm(w.repo) === norm(repo)) || null;
  return { feature: self.feature, branch: self.branch, repo, member, rel: path.relative(path.resolve(repo), path.resolve(file)) }; // win32 path.relative ignores case
}

// The same guard for shell commands (Bash / PowerShell), which the edit hook can't see by path. Deliberately
// narrow so normal work never trips it: only a command that clearly CHANGES a repo's main checkout —
// a state-changing git command run there (cd <repo> ... / git -C <repo>), sed -i on a file there, or a
// > / >> redirect into a file there. Reading, git status/log/diff, copying out and running scripts pass.
// Read-only forms of these (stash list/show, apply --check/--stat) are left out.
const GIT_WRITE = '(?:commit|checkout|switch|reset|merge|rebase|pull|push|stash(?!\\s+(?:list|show)\\b)|add|rm|mv|restore|cherry-pick|revert|apply(?!\\s+--(?:check|stat|numstat|summary)\\b)|am)';
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fwd = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
function planShellRedirect({ command, cwd, worktrees, repos }) {
  if (!command || !cwd) return null;
  const self = (worktrees || []).find(w => w.feature && norm(w.path) === norm(cwd));
  if (!self) return null;
  const mine = worktrees.filter(w => w.feature === self.feature);
  // One spelling to match against: forward slashes, Git Bash's /c/... as C:/...
  const cmd = fwd(command).replace(/(^|[\s"'=;&|(])\/([a-zA-Z])\//g, (_, pre, d) => `${pre}${d.toUpperCase()}:/`);
  const all = candidates(repos, worktrees, mine).sort((a, b) => fwd(b).length - fwd(a).length);
  for (const repo of all) {
    const R = esc(fwd(repo)), at = String.raw`["']?${R}(?:/[^\s"';&|]*)?["']?`, into = String.raw`["']?${R}/`;
    const hit = [
      // ...until the next cd: "cd <main> && git diff > p && cd <worktree> && git apply p" is the copy-out flow
      new RegExp(String.raw`\bcd\s+${at}\s*(?:&&|;|\n)(?:(?!\bcd\s)[\s\S])*?\bgit\s+${GIT_WRITE}\b`, 'i'),
      new RegExp(String.raw`\bgit\s+-C\s+${at}\s+${GIT_WRITE}\b`, 'i'),
      new RegExp(String.raw`\bsed\s+(?:-[a-zA-Z]*i[a-zA-Z]*|--in-place)\b[^|;&]*${into}`, 'i'),
      new RegExp(String.raw`(?:^|[^0-9&>])>>?\s*${into}`, 'i'),
    ].some(re => re.test(cmd));
    if (!hit) continue;
    return { feature: self.feature, branch: self.branch, repo, member: mine.find(w => norm(w.repo) === norm(repo)) || null };
  }
  return null;
}

module.exports = { planRedirect, planShellRedirect };
