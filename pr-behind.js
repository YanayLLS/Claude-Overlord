// How far each PR branch trails its base branch, batched into one GraphQL call.
// The main PR query can't answer this: `ref.compare(headRef:)` needs the head
// branch name as a literal, which is only known once the PRs come back.

// Compared from the PR branch toward its base: the comparison's `commits` are
// then the ones the base has that the branch lacks, each with its parent count,
// so merge commits can be told apart. A release PR (dev → alpha) whose base
// only holds the merge nodes of earlier release PRs is not behind — every
// change in them is already on dev. `behindBy` stays as the fallback.
const BEHIND_PAGE = 100;

function buildBehindQuery(prs) {
  const usable = (prs || []).filter(p => p && p.repo && p.headRef && p.baseRef);
  if (!usable.length) return null;
  const parts = usable.map((p, i) => {
    const [owner, name] = p.repo.split('/');
    return `b${i}: repository(owner:${JSON.stringify(owner)}, name:${JSON.stringify(name)}) { `
      + `ref(qualifiedName:${JSON.stringify(p.headRef)}) { `
      + `compare(headRef:${JSON.stringify(p.baseRef)}) { behindBy `
      + `commits(first:${BEHIND_PAGE}) { totalCount nodes { parents { totalCount } } } } } }`;
  });
  return { query: `query {\n${parts.join('\n')}\n}`, keys: usable.map(p => p.key) };
}

// → { key: non-merge commits the base has that the branch lacks }. Missing/
// errored aliases are simply absent, which the renderer treats as "unknown"
// rather than "up to date". Beyond one page the raw count is used — that far
// behind is behind whatever the merge share.
function parseBehind(json, keys) {
  const data = (json && json.data) || {};
  const out = {};
  (keys || []).forEach((key, i) => {
    const node = data['b' + i];
    const c = node && node.ref && node.ref.compare;
    if (!c || typeof c.behindBy !== 'number') return;
    const commits = c.commits;
    if (!commits || !Array.isArray(commits.nodes) || commits.totalCount > BEHIND_PAGE) { out[key] = c.behindBy; return; }
    out[key] = commits.nodes.filter(n => n && n.parents && n.parents.totalCount === 1).length;
  });
  return out;
}

// Which branch-state button a PR row gets: 'conflict' | 'update' | null.
// Only the PR's own author can push to its branch, so nobody else sees either.
// Conflicts win over behind — GitHub's update button can't run until they're
// resolved, and it's the same base merge either way.
// ponytail: GitHub's API exposes no conflicted-file list, so no count.
function prBranchAction(p) {
  if (!p || !p.mine) return null;
  if (p.mergeable === 'CONFLICTING' || p.mergeState === 'DIRTY') return 'conflict';
  return p.behindBy > 0 ? 'update' : null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildBehindQuery, parseBehind, prBranchAction };
}
