// "Fix blockers" on the release candidate card: one agent works through every blocking module (each module's causes
// together), each fix on its own branch into the rc branch (rc/<run>, frozen at the tested commits), then the card
// merges and re-runs once every fix PR is green and approved. Pure: the brief an agent follows, how its result file
// is read, and what the card shows per module. releases-main.js does the I/O.

// What an agent writes when it is done, to the path its brief names (one JSON object):
//   { "status": "pr", "url": "<pull request url>" }
//   { "status": "declined", "reason": "<one line>", "question": "<product question, if that is why>" }
// fixed-on-dev / open-elsewhere: written by briefs from before the rc branch; still read.
const STATUSES = new Set(['pr', 'fixed-on-dev', 'open-elsewhere', 'declined']);
function readResult(text) {
  let j; try { j = JSON.parse(String(text || '')); } catch { return null; }
  return j && STATUSES.has(j.status) ? j : null;
}
const prNumber = (url) => { const m = String(url || '').match(/\/pull\/(\d+)/); return m ? Number(m[1]) : null; };
const tick = (s) => String(s).replace(/`/g, "'");

// One brief per blocking module (rc-core grade().blockers). base: the rc branch the fix goes to; dev: the integration
// branch others push to; others: the other repos with the same rc branch; testedSha: the commit the run tested.
function briefFor({ blocker, i, nightlyId, repo, base, dev = 'dev', others = [], testedSha, reportUrl, runUrl, resultPath, skill }) {
  const branch = `fix/rc-${nightlyId}-${i}`;
  const since = testedSha || '<tested sha>';
  const causes = blocker.causes.map((c, n) => [
    `### Cause ${n + 1}${c.critical ? ' · **@critical**' : ''}`,
    `- Scenarios: ${c.scenarios.map(s => `"${s}"`).join(', ')}`,
    `- Failing step: \`${tick(c.step)}\``,
    `- First error: \`${tick(c.error)}\``,
    `- In the report: ${c.url || reportUrl}`,
  ].join('\n')).join('\n\n');
  const elsewhere = others.length ? `\n- \`${base}\` also exists in ${others.join(', ')} at their tested commits: a fix there is a PR into that repo's \`${base}\`` : '';
  return `# Fix the release blockers in one module

The release candidate (graded from run ${runUrl}) is held by these failures in module \`${blocker.module}\` (${blocker.tag}). Several causes can share one breakage: find it, fix every cause you can, or say precisely why not.

- Repo: ${repo} · the run tested \`${testedSha || 'unknown'}\`
- Fixes go to \`${base}\`: a branch frozen at the tested commit, so the release is exactly what was tested plus the fixes. \`${dev}\` keeps moving; it gets your fix when \`${base}\` merges back after the release.${elsewhere}

${causes}

## 1. First: has someone already fixed it?
Other people push fixes to \`${dev}\` all the time. Before anything else:
- \`git fetch origin ${dev}\` and look at what landed since the tested commit: \`git log --oneline ${since}..origin/${dev} -- <the feature files, their step definitions, their page objects and the product code they drive>\`.
- \`gh pr list -R ${repo} --state open --search "<scenario words or module>"\`.
- A commit on \`${dev}\` (or someone's open PR) that plainly fixes these causes → don't redo it: cherry-pick exactly that change onto your branch (step 2) and say in the PR body whose change it is and where it came from. Nothing else from \`${dev}\` comes along.

## 2. Otherwise fix it
Follow \`${skill}\` (run by hand: open a PR instead of emitting patch files; its rules, risk tiers and red-then-green ledger apply, the ledger goes in the PR body).
- \`git fetch origin ${base}\`, then work in your own git worktree on branch \`${branch}\` from \`origin/${base}\`. Never edit the shared checkout, never \`git stash\`.
- **Do not run BDD, Playwright or browsers locally** (other agents run beside you). Prove it on CI: open ONE PR against \`${base}\` with a \`\`\`bdd block naming \`${blocker.module}\` narrowed with \`scenarios:\` to the ones above (as a mapping, see docs/rules/bdd-ci.md), and wait for its run. Unit tests of files you touch are fine at low priority.
- No scenario removal, no @skip/@future/@known-red, no weaker assertion, no wider timeout to hide a cause.
- Name the ticket so ClickUp follows the fix: the nightly opens one ClickUp ticket per failing module in the Frontline One list (901523262937), titled like "<Area> | ${blocker.module} fails in nightly regression". Find the open one for \`${blocker.module}\` (ClickUp search) and end your PR title with \`(CU-<its id>)\`. None found → say so in the PR body.
- A product decision you cannot make from the code → decline with the question.
- Then write \`{"status":"pr","url":"<pr url>"}\`.

## 3. Write the result
One JSON object to \`${resultPath}\` (write a temp file then rename it, so a half-written file is never read). Statuses: \`pr\` (into \`${base}\`), \`declined\` (with \`reason\` and, when that is why, \`question\`).
`;
}

// The card's state per module, from the result file and the PR (when there is one).
// pr: { state, merged, green, pending, approved } as read from GitHub, or null.
function causeState({ started, result, pr }) {
  if (!started) return { kind: 'queued' };
  if (!result) return { kind: 'working' };
  if (result.status === 'declined') return { kind: result.question ? 'needs-you' : 'declined', text: result.question || result.reason };
  if (result.status === 'fixed-on-dev') return { kind: 'fixed', url: result.url, by: result.by };
  if (!pr) return { kind: result.status === 'open-elsewhere' ? 'elsewhere' : 'pr', url: result.url, by: result.by };
  if (pr.merged) return { kind: 'merged', url: result.url };
  if (pr.state === 'closed') return { kind: 'closed', url: result.url };
  // green but nobody has approved: the branch needs one review before it can merge
  const kind = pr.green ? (pr.approved === false ? 'review' : 'green') : pr.pending ? 'running' : 'red';
  return { kind, url: result.url, by: result.by, mine: result.status === 'pr' };
}

// Merge & re-run is offered when nothing is queued, being worked on or waiting for review, and every PR this card
// opened is green and approved (or merged). Declined modules don't hold it back.
function readyToMerge(states) {
  const list = Object.values(states || {});
  if (!list.length || list.some(s => ['queued', 'working', 'running', 'red', 'review'].includes(s.kind))) return false;
  return list.some(s => s.kind === 'green' && s.mine) || list.every(s => ['merged', 'fixed', 'declined', 'needs-you', 'elsewhere', 'closed'].includes(s.kind));
}

// GitHub's check-runs → green / pending / red.
function checksVerdict(runs) {
  const list = (runs || []).filter(r => r && r.name);
  if (!list.length) return { pending: true };
  if (list.some(r => r.status !== 'completed')) return { pending: true };
  const ok = list.every(r => ['success', 'skipped', 'neutral'].includes(r.conclusion));
  return ok ? { green: true } : { red: true };
}

// Latest review per reviewer → approved, unless someone's latest asks for changes.
function approvedBy(reviews) {
  const last = new Map();
  for (const r of reviews || []) if (r && r.user && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) last.set(r.user.login, r.state);
  const states = [...last.values()];
  return states.includes('APPROVED') && !states.includes('CHANGES_REQUESTED');
}

module.exports = { readResult, prNumber, briefFor, causeState, readyToMerge, checksVerdict, approvedBy };
