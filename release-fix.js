// Release blockers fix themselves: once an open release's rows settle blocked (failing checks, a dbschemas version
// its build doesn't ship, a conflict), one agent fixes each on the release PR's own head branch, so the PR the
// signers see already carries the fix, and opens the same commits as a PR into the source branch so dev keeps it.
// Pure: which rows to fix, how often, and the brief. releases-main.js starts the agent.

const MAX_TRIES = 2; // per release and repo: a fix that did not hold gets one more go, then a person looks

// What blocks a row, in words an agent can act on. Pending checks are not a blocker yet.
function reasonsOf(r) {
  const out = [];
  if (r.checks === 'fail') out.push('checks failing');
  if (r.dbschemas && r.dbschemas.used && r.dbschemas.used.length) out.push(`uses dbschemas ${r.dbschemas.used.join(', ')}, added after the ${r.dbschemas.shipped || 'shipped'} its lockfile pins (latest ${r.dbschemas.latest || 'unknown'})`);
  if (r.conflict === true) out.push(`conflicts with ${r.target}`);
  if (r.backMerge && r.backMerge.conflict) out.push(`its back-merge ${r.target} → ${r.source} conflicts`);
  return out;
}

// Rows to hand to an agent now; tries: { '<runKey>|<repo>': n } of earlier starts.
function rowsToFix(rows, runKey, tries = {}) {
  return (rows || []).filter(r => r.pr && !r.merged && !r.closed && r.status === 'blocked' && reasonsOf(r).length
    && (tries[`${runKey}|${r.repo}`] || 0) < MAX_TRIES);
}

function briefFor(rows, { snapshotRef, workRoot }) {
  const items = rows.map((r) => {
    const head = snapshotRef(r.source, r.target);
    return [
      `## ${r.label || r.repo} · ${r.pr.url || `https://github.com/${r.repo}/pull/${r.pr.number}`}`,
      `- Repo ${r.repo}: release PR \`${head}\` → \`${r.target}\`, source branch \`${r.source}\``,
      ...reasonsOf(r).map(x => `- Blocked: ${x}`),
    ].join('\n');
  }).join('\n\n');
  return `# Fix the blockers of the open release

The release is open for signatures and these release PRs would stop Release all. Fix each one so the PR is green
before anyone signs. Work through them one at a time.

${items}

## How
1. Find the cause: \`gh pr checks <n> -R <repo>\` and \`gh run view <id> --log-failed\` for failing checks.
   A check that failed on infrastructure noise (a runner died, a timeout talking to GitHub) is re-run
   (\`gh run rerun <id> --failed\`), not patched. A dbschemas blocker: set \`@llsltd/dbschemas\` to the latest
   version in package.json and package-lock.json (check its diff changed no dependencies).
2. Work in a git worktree under ${workRoot}/wt, branched from \`origin/<head branch>\`; the repo's clone is
   usually ${workRoot}/<repo name>. Never stash, never commit files you did not change.
3. Commit (Conventional Commits), push the branch, then push the same commit fast-forward onto the head branch
   (\`git push origin HEAD:<head branch>\`). Never force-push and never merge a release PR: the signers do that.
4. Open a PR of the fix branch into the source branch, its body ending with the Claude Code line.
5. A blocker you cannot fix safely (a real conflict between features, a product decision): leave it and say why
   in one line at the end. Overlord re-checks the release PRs by itself.

Low CPU: one install or test run at a time, at low priority.
`;
}

module.exports = { MAX_TRIES, reasonsOf, rowsToFix, briefFor };
