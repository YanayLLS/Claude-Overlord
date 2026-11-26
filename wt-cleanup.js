// Closing a worktree whose branch has an open PR: it leaves Overlord at once, but its folder and branch stay
// until that PR merges (settings.pendingCleanups). A PR closed without merging keeps them; the entry is dropped.
const SLUG_RE = /^[\w.-]+\/[\w.-]+$/;

// Every PR from the branch, any state. A plain GET, so gh-cache answers repeats with a free 304.
function prQueryArgs(slug, branch) {
  if (!SLUG_RE.test(String(slug || '')) || !branch) return null;
  return ['api', '-X', 'GET', `/repos/${slug}/pulls`, '-f', `head=${slug.split('/')[0]}:${branch}`, '-f', 'state=all', '-f', 'per_page=10'];
}

// The open PR the delete waits for, or null (delete now).
function openPrOf(prs) {
  if (!Array.isArray(prs)) return null;
  const open = prs.find(p => p && p.state === 'open');
  return open ? open.number : null;
}

// 'delete' once the PR merged, 'keep' (drop the entry, leave the folder) when it closed unmerged or the
// folder is a worktree again, 'wait' while it is open or GitHub gave no answer.
function cleanupVerdict(prs, pending, inUse = false) {
  if (inUse) return 'keep';
  if (!Array.isArray(prs)) return 'wait';
  const pr = prs.find(p => p && p.number === pending.pr);
  if (!pr || pr.state !== 'closed') return 'wait';
  return pr.merged_at ? 'delete' : 'keep';
}

function addPending(list, item) {
  const k = String(item.path).toLowerCase();
  return [...(list || []).filter(p => String(p.path).toLowerCase() !== k), item];
}

module.exports = { prQueryArgs, openPrOf, cleanupVerdict, addPending };
