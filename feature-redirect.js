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

module.exports = { planRedirect };
