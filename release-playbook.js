// The brief a Release-button agent follows: which PRs to open (from the board config) and how
// to open them safely. Adapted from the frontend repo's /release skill, generalised so the repo
// list comes from releasePlan() instead of a hard-coded map. A .js module, not .md, because the
// packaged app drops *.md.

function releaseBrief({ envs, plan, configSource, flagCheck }) {
  const L = [];
  L.push(`# Release: ${envs.join(' + ')}`, '');
  L.push('You were started by Overlord\'s **Release** button. Open the promotion PRs below, open a back-merge PR wherever the target is ahead of the source, unblock conflicting or red release PRs (new or already open) through a PR into the source, and finish with the report table. Work through every row; run independent rows in parallel.', '');
  L.push('**Never merge a PR. Never push to `dev`/`alpha`/`master`/`main`/`prod-one`/`staging`.** PR heads are existing remote branches, so nothing local is touched, except a conflict resolution branch (see [Conflicts](#conflicts--resolve-back-into-the-source)).', '');
  L.push(`The list comes from the releases config \`${configSource}\` (its \`branches\` + \`promote\`). Never infer a target from \`origin/HEAD\`, \`gh repo view\` or the branch name \`main\`.`, '');

  L.push('## Release PRs to open', '');
  if (!plan.prs.length) L.push('_None: no repo promotes into the selected env(s)._', '');
  else {
    L.push('| Repo | Env | Source → target |', '|---|---|---|');
    for (const p of plan.prs) L.push(`| \`${p.repo}\` (${p.label}) | ${p.env} | \`${p.source}\` → \`${p.target}\` |`);
    L.push('');
  }

  L.push('## Deployed by hand: report only, never PR', '');
  if (!plan.manual.length) L.push('_None for the selected env(s)._', '');
  else {
    for (const m of plan.manual) {
      if (m.live) {
        L.push(`- \`${m.repo}\` · ${m.env}: runs the commit pinned in \`${m.live.from}\` (regex \`${m.live.match}\`, first group = sha). Read that file, then report the pinned sha and how many \`${m.branch}\` commits are past it: \`gh api repos/${m.repo}/compare/<sha>...${m.branch} --jq .ahead_by\`. Shipping it is a hand deploy, not a PR.`);
      } else {
        L.push(`- \`${m.repo}\` · ${m.env}: deployed by hand from \`${m.branch}\`; nothing records the live commit. Report "${m.env} = manual deploy of \`${m.branch}\`, live commit unknown" and how far \`${m.branch}\` has moved since its last hand deploy if you can tell (e.g. tfvars image tag in \`LLSLtd/servers-infrastructure\`).`);
      }
    }
    L.push('');
  }

  L.push(`## Per release PR (repo, source → target)

1. **Anything to ship?**
   \`gh api repos/<repo>/compare/<target>...<source> --jq '{ahead: .ahead_by, files: (.files|length)}'\`
   - \`ahead == 0\` or \`files == 0\` → "nothing to release", no PR.
   - **Hotfix check:** \`gh api repos/<repo>/compare/<source>...<target> --jq '[.commits[]|select(.parents|length==1)]|length'\`. Non-zero → the target holds real commits the source lacks. Still open the release PR, flag it in the report and body, **and open a back-merge PR** (below). Ignore raw \`behind_by\`: every past release merge commit counts there. A repo whose target carries its own \`ci(deploy)\` commits (e.g. remote-support-web \`prod-one\`) is never 0 there; drop those before deciding.
2. **Already open?** \`gh pr list -R <repo> --base <target> --head <source> --state open --json number,url\`. If one exists, do not open a second: skip to step 5 and **unblock it** (conflicts, failing checks) exactly as if you had just opened it. Re-check right before step 4.
3. **Body.** Compare returns 250 commits per page, so paginate:
   \`gh api --paginate "repos/<repo>/compare/<target>...<source>?per_page=100" --jq '.commits[]|select(.parents|length==1)|.commit.message|split("\\n")[0]'\`
   - one line: env + what merging deploys (read the target branch's deploy workflow: \`gh api repos/<repo>/contents/.github/workflows?ref=<target>\`)
   - \`N commits (M non-merge)\`; the hotfix warning if any
   - **By type**: counts of conventional prefixes (\`fix\`, \`feat\`, …)
   - **Highlights by area**: group by scope, biggest first, one plain-language line each for the top ~8; the rest as a comma list
   - end with the PR attribution lines from your system reminder
4. **Open.** \`gh pr create -R <repo> --base <target> --head <source> --title "chore(release): promote <source> to <target>" --body-file <scratchpad file>\`
5. \`gh pr view <url> --json mergeable\`: \`UNKNOWN\` → wait a few seconds and ask again; \`CONFLICTING\` → the back-merge below is what unblocks it. Never leave a conflicting release PR only "flagged".
6. **Checks.** \`gh pr checks <url>\`. Pending → note it, don't wait on it. Failing → [Unblock a failing release PR](#unblock-a-failing-release-pr). Never leave a red release PR only "flagged".

## Unblock a failing release PR

A release PR's head IS the source branch, so the fix goes **into the source** through its own PR; once that merges, the release PR re-runs and turns green by itself. Never open a second release PR.

1. **Read why:** \`gh pr checks <url>\` for the failed check → its run id → \`gh run view <id> -R <repo> --log-failed\`. Already a fix PR open into the source? (\`gh pr list -R <repo> --base <source> --head fix/release-<target>-checks --state open\`) → reuse it, report it.
2. **Flaky / infra, not code** (timeouts, a registry or network error, a runner that died, a test that passes on retry): \`gh run rerun <id> -R <repo> --failed\` once and report "re-ran <check>". If it fails the same way again, treat it as real.
3. **Real failure:** a worktree off the source exactly as in [Conflicts](#conflicts--resolve-back-into-the-source) step 1, but branch \`fix/release-<target>-checks\`. Reproduce locally (the failing test/typecheck/lint command from the log), make the smallest fix, re-run that command until it passes, commit with the attribution line, push the fix branch only, and open \`gh pr create -R <repo> --base <source> --head fix/release-<target>-checks --title "fix: unblock the <target> release — <what failed>" --body-file <file>\`. Body: which release PR it unblocks (link), the failing check and root cause, what changed, the verification you ran. Into the frontend's \`dev\` → add the \`\`\`bdd block. Clean up the worktree.
4. **Can't fix it safely** (needs secrets, a product decision, or a change you can't verify): don't guess. Report the failing check, the root cause you found, and what's needed.
5. Report: "merge fix PR #N first, then the release PR".

## Back-merge: align the source with the target first

Whenever the hotfix check is non-zero, bring the target's commits back **before** the release merges, so the source never silently loses a hotfix. One PR per (repo, target → source):

1. **Already open?** \`gh pr list -R <repo> --base <source> --head <target> --state open --json number,url\`: reuse it. Also skip if an open \`chore/resolve-<target>-into-<source>\` PR exists.
2. **Only real hotfixes count:** \`gh api --paginate "repos/<repo>/compare/<source>...<target>?per_page=100" --jq '.commits[]|select(.parents|length==1)|.commit.message|split("\\n")[0]'\`. Drop \`ci(deploy)\` commits; if nothing is left, no back-merge.
3. **Open:** \`gh pr create -R <repo> --base <source> --head <target> --title "chore(merge): align <source> with <target>" --body-file <file>\`. Body: which release PR it gates (link), the hotfix commits it brings, the attribution lines. If the source is \`dev\` of \`LLSLtd/frontlineio-frontend\`, add a \`\`\`bdd block naming the scopes the hotfix files can break (\`scopes: []\` if none).
4. \`gh pr view <url> --json mergeable\`: \`CONFLICTING\` → close it (\`gh pr close <url> --comment "superseded by the resolution PR"\`) and go to Conflicts.
5. Report both URLs: "merge the back-merge PR first, then the release PR".

## Conflicts: resolve back into the source

The fix never goes on the release PR (its head IS the source) nor the back-merge (its head IS the target): merge the **target into the source** on a throwaway branch and PR it into the source. Once that merges, the release PR turns mergeable by itself.

1. **A worktree off the source, never the user's checkout** (it is dirty and on their branch). Find the repo's local clone (usually \`C:\\Work\\<name>\`), then:
   \`git fetch origin <source> <target>\` · \`git worktree add --detach ../<name>-release-resolve origin/<source>\` · \`cd\` there · \`git checkout -b chore/resolve-<target>-into-<source>\` · \`git merge origin/<target>\`
   No local clone → \`gh repo clone <repo> <scratchpad>/<name> -- --branch <source> --depth 50\` and fetch \`<target>\` into it.
2. **Resolve by intent, as a union.** For each hunk read both sides (\`git log -p origin/<target> -3 -- <file>\` / same for source). A hotfix and a feature on the same lines almost always both belong. Files may be CRLF: use the Edit tool, not sed.
3. **Verify:** \`npm ci --ignore-scripts\` in the worktree (never junction \`node_modules\`), then the repo's typecheck script and the unit tests beside every conflicted file. If that is not possible, say "resolution not verified locally" in the PR body.
4. **Commit** with the default merge message plus one line per conflicted file saying what was kept, and the commit attribution line from your system reminder.
5. **Push the resolution branch only** and open the PR **into the source**: \`gh pr create -R <repo> --base <source> --head chore/resolve-<target>-into-<source> --title "chore(merge): resolve <target> into <source> for the release" --body-file <file>\`. For the frontend's \`dev\`, add the \`\`\`bdd block.
6. **Clean up** the worktree. Report "merge the resolution PR first".
`);

  if (flagCheck) {
    L.push(`## Feature flags on prod

Flags are rows in each cluster's \`global.featureflags\`; a flag added on dev never reaches prod by itself. Before opening PRs run (read-only): \`node ${flagCheck}\`
- \`catalogueMissingOnProd\` → a real gap. Put a **⚠ Seed before merging** line naming the keys at the top of the frontend, backend and back-office prod PR bodies and in the report, with the seed command per key, dry run first: \`cd C:/Work/back-office && node server/scripts/syncFlagCatalog.js --only <Key> --allow-prod\` (then \`--apply\`). **Never run \`--apply\` yourself.** A default-ON flag switches the feature on for every prod workspace.
- \`frontendMissingOnProd\` with \`onDev: false\` → exists on no cluster; mention once. \`devOnlyRows\` → ignore.
- Script errors → report "flag check failed: <message>" and continue.
`);
  }

  L.push(`## Report

End with a TL;DR table, one row per repo × env (release PRs first, then the hand-deployed rows):

| Repo | Env | Result |
|---|---|---|
| frontlineio-frontend | prod | #812 · 146 commits · ⚠ master ahead by 1 → back-merge PR #813 master → dev, merge it first |
| identity-server | prod | nothing to release |
| auth-server | prod | manual deploy of \`main\`, live commit unknown |

## Common mistakes

- Opening a PR into a branch that isn't in the table above (e.g. backend \`master\` is the legacy monolith; \`main\` is stale on remote-support-web and AI-chat-front).
- Opening a duplicate while an older release PR is still open: reuse it; it tracks the head branch.
- Adding a \`\`\`bdd block to a release PR: BDD only runs on PRs into \`dev\`. The resolution / back-merge PR into \`dev\` does need one.
- Flagging "target ahead" without opening the back-merge PR.
- Resolving a conflict by pushing to the source directly, or by PR-ing into the target.
- Opening a second release PR after resolving or fixing: the existing one turns mergeable/green once the fix merges into the source.
- Skipping an already-open release PR because it exists: it still needs unblocking (conflicts, red checks).
- Pushing a fix straight to the source branch: every fix goes through a PR into the source.
`);
  return L.join('\n');
}

// "Fix all" after a release run: every blocked row in one brief, led by what the deterministic
// run found, so the agent starts at the blockers and touches nothing else.
function releaseFixBrief({ rows, configSource }) {
  const lines = ['# Unblock the release', '',
    `Overlord already ran this release deterministically. ${rows.length} row${rows.length === 1 ? ' is' : 's are'} blocked:`, ''];
  for (const row of rows) {
    const why = [];
    if (row.conflict) why.push(`release PR #${row.pr.number} conflicts with \`${row.target}\``);
    if (row.checks === 'fail') why.push(`release PR #${row.pr.number} has failing checks`);
    if (row.backMerge && row.backMerge.conflict) why.push(`back-merge PR #${row.backMerge.number} (\`${row.target}\` → \`${row.source}\`) conflicts`);
    if (row.error) why.push(`the run failed: ${row.error}`);
    lines.push(`- **\`${row.repo}\` · ${row.env}** (\`${row.source}\` → \`${row.target}\`): ${why.join('; ')}`
      + (row.pr ? ` · ${row.pr.url}` : '') + (row.backMerge && row.backMerge.url ? ` · back-merge ${row.backMerge.url}` : ''));
  }
  lines.push('', 'Rows that share a source branch (e.g. the same repo\'s `dev` → `alpha` and `dev` → `master`) usually share one cause: one fix PR into the source unblocks them all.', '',
    '**Only these rows.** Do not open new release PRs; unblock the existing ones with the sections below (Back-merge / Conflicts / Unblock a failing release PR), then report.', '');
  const envs = [...new Set(rows.map(r => r.env))];
  return lines.join('\n') + '\n' + releaseBrief({ envs, plan: { prs: rows, manual: [] }, configSource, flagCheck: null });
}

module.exports = { releaseBrief, releaseFixBrief };
