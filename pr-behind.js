// How far each PR branch trails its base branch, batched into one GraphQL call.
// The main PR query can't answer this: `ref.compare(headRef:)` needs the head
// branch name as a literal, which is only known once the PRs come back.

function buildBehindQuery(prs) {
  const usable = (prs || []).filter(p => p && p.repo && p.headRef && p.baseRef);
  if (!usable.length) return null;
  const parts = usable.map((p, i) => {
    const [owner, name] = p.repo.split('/');
    return `b${i}: repository(owner:${JSON.stringify(owner)}, name:${JSON.stringify(name)}) { `
      + `ref(qualifiedName:${JSON.stringify(p.baseRef)}) { `
      + `compare(headRef:${JSON.stringify(p.headRef)}) { behindBy } } }`;
  });
  return { query: `query {\n${parts.join('\n')}\n}`, keys: usable.map(p => p.key) };
}

// → { key: behindBy }. Missing/errored aliases are simply absent, which the
// renderer treats as "unknown" rather than "up to date".
function parseBehind(json, keys) {
  const data = (json && json.data) || {};
  const out = {};
  (keys || []).forEach((key, i) => {
    const node = data['b' + i];
    const n = node && node.ref && node.ref.compare && node.ref.compare.behindBy;
    if (typeof n === 'number') out[key] = n;
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
