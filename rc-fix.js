// "Fix blockers" on the release candidate card: one agent per blocking root cause, each on its own branch from
// the integration branch, then "Merge & re-run" once every fix PR is green. Pure: the brief an agent follows,
// how its result file is read, and what the card shows per cause. releases-main.js does the I/O.

// What an agent writes when it is done, to the path its brief names (one JSON object):
//   { "status": "pr", "url": "<pull request url>" }
//   { "status": "fixed-on-dev", "url": "<commit or merged PR url>", "by": "<who>" }   someone already fixed it
//   { "status": "open-elsewhere", "url": "<someone else's open PR url>", "by": "<who>" } a fix is already in review
//   { "status": "declined", "reason": "<one line>", "question": "<product question, if that is why>" }
const STATUSES = new Set(['pr', 'fixed-on-dev', 'open-elsewhere', 'declined']);
function readResult(text) {
  let j; try { j = JSON.parse(String(text || '')); } catch { return null; }
  return j && STATUSES.has(j.status) ? j : null;
}
const prNumber = (url) => { const m = String(url || '').match(/\/pull\/(\d+)/); return m ? Number(m[1]) : null; };

// One brief per cause. testedSha: the commit the graded run tested, so the agent can see what landed on the
// base since (someone may already have fixed it).
function briefFor({ cause, i, nightlyId, repo, base, testedSha, reportUrl, runUrl, resultPath, skill }) {
  const branch = `fix/rc-${nightlyId}-${i}`;
  return `# Fix one release blocker

The release candidate (graded from run ${runUrl}) is held by this root cause. Fix it, or say precisely why not.

- Module (cucumber profile): \`${cause.module}\`${cause.critical ? ' · **@critical**' : ''}
- Scenarios: ${cause.scenarios.map(s => `"${s}"`).join(', ')}
- Failing step: \`${cause.step}\`
- First error: \`${String(cause.error).replace(/`/g, "'")}\`
- Where it failed in the report: ${cause.url || reportUrl}
- Repo: ${repo} · base \`${base}\` · the run tested \`${testedSha || 'unknown'}\`

## 1. First: has someone already fixed it?
Other people push fixes to \`${base}\` all the time. Before anything else:
- \`git fetch origin ${base}\` and look at what landed since the tested commit: \`git log --oneline ${testedSha || '<tested sha>'}..origin/${base} -- <the feature file, its step definitions, its page objects and the product code they drive>\`.
- \`gh pr list -R ${repo} --state open --search "<scenario words or module>"\`.
- A commit on \`${base}\` that plainly fixes this cause → write \`{"status":"fixed-on-dev","url":"<commit url>","by":"<author>"}\` and stop.
- Someone else's open PR that fixes it → write \`{"status":"open-elsewhere","url":"<pr url>","by":"<author>"}\` and stop. Do not open a second PR.

## 2. Otherwise fix it
Follow \`${skill}\` (run by hand: open a PR instead of emitting patch files; its rules, risk tiers and red-then-green ledger apply, the ledger goes in the PR body).
- Work in your own git worktree on branch \`${branch}\` from \`origin/${base}\`. Never edit the shared checkout, never \`git stash\`.
- **Do not run BDD, Playwright or browsers locally** (other agents run beside you). Prove it on CI: open the PR against \`${base}\` with a \`\`\`bdd block naming \`${cause.module}\` narrowed with \`scenarios:\` to the ones above (as a mapping, see docs/rules/bdd-ci.md), and wait for its run. Unit tests of files you touch are fine at low priority.
- No scenario removal, no @skip/@future/@known-red, no weaker assertion, no wider timeout to hide a cause.
- A product decision you cannot make from the code → decline with the question.
- Then write \`{"status":"pr","url":"<pr url>"}\`.

## 3. Write the result
One JSON object to \`${resultPath}\` (write a temp file then rename it, so a half-written file is never read). Statuses: \`pr\`, \`fixed-on-dev\`, \`open-elsewhere\`, \`declined\` (with \`reason\` and, when that is why, \`question\`).
`;
}

// The card's state per cause, from the result file and the PR (when there is one).
// pr: { state, merged, green, pending } as read from GitHub, or null.
function causeState({ started, result, pr }) {
  if (!started) return { kind: 'idle' };
  if (!result) return { kind: 'working' };
  if (result.status === 'declined') return { kind: result.question ? 'needs-you' : 'declined', text: result.question || result.reason };
  if (result.status === 'fixed-on-dev') return { kind: 'fixed', url: result.url, by: result.by };
  if (!pr) return { kind: result.status === 'open-elsewhere' ? 'elsewhere' : 'pr', url: result.url, by: result.by };
  if (pr.merged) return { kind: 'merged', url: result.url };
  if (pr.state === 'closed') return { kind: 'closed', url: result.url };
  return { kind: pr.green ? 'green' : pr.pending ? 'running' : 'red', url: result.url, by: result.by, mine: result.status === 'pr' };
}

// Merge & re-run is offered when nothing is still being worked on and every PR this card opened is green (or
// merged). Causes fixed on the base or declined don't hold it back; someone else's PR is theirs to merge.
function readyToMerge(states) {
  const list = Object.values(states || {});
  if (!list.length || list.some(s => s.kind === 'working' || s.kind === 'running' || s.kind === 'red')) return false;
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

module.exports = { readResult, prNumber, briefFor, causeState, readyToMerge, checksVerdict };
