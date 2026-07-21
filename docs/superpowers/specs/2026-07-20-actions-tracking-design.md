# GitHub Actions tracking — design

Mirror of the PR notifications feature, for workflow runs. Pick repos and
specific workflows in Settings; a badge under the PR badge shows their live
state; a dropdown lists one row per tracked workflow, click opens the run.

## Storage

New `settings.actionsSettings`, sibling of `prSettings`, written by
`saveActionsSettings` into the same `overlord-state.json` blob:

```js
{
  enabled: false,
  intervalSec: 60,
  workflows: [{ repo: 'LLSLtd/frontlineio-frontend', file: 'deploy-ecs.yml', name: 'Deploy ECS' }],
}
```

A flat list, not `repo -> workflows`. Both the poller and the renderer iterate
workflows, never repos, so nesting would only add unwrapping. `name` is a
display cache; if absent the renderer falls back to `file`.

Key identity is `` `${repo}/${file}` `` — used for dedupe on add and as the
row key.

## Settings UI

New block in the settings modal after the PR block (`index.html` ~1086), same
markup idiom (label + control rows, no Save button — changes persist on
change):

- `#chk-actions` — master enable.
- `#inp-actions-interval` — idle poll seconds, min 30, default 60.
- `#inp-actions-add` — one text box accepting either:
  - a full workflow URL (`https://github.com/O/R/actions/workflows/deploy-ecs.yml`)
    → adds that workflow directly, no API call;
  - `owner/repo` (or a repo URL) → sends `listWorkflows`, which renders a
    checkbox list of that repo's workflows to tick.
- `#actions-wf-list` — the tracked list, each row with a `✕` remove.
- `#actions-repo-wf` — transient checkbox list from `listWorkflows`.

Hydrated on startup alongside `prSettings` in the `settings` message handler.

## Fetch

`gh` CLI, matching the PR section's conventions (`repairGhPath`, `ghErrCode`,
`ghErr` reused unchanged). The Actions REST endpoint has no useful GraphQL
equivalent, so it is one call per tracked workflow, run in parallel:

```
gh api /repos/{repo}/actions/workflows/{file}/runs?per_page=1
```

`per_page=1` returns the latest run on any branch, which is what the user
asked to see. Individual failures degrade to a per-row error rather than
losing the whole poll, mirroring `fetchAllPRs`'s `failed[]` handling. Total
failure sends `runs: null` so the renderer keeps its last list.

Listing a repo's workflows: `gh api /repos/{repo}/actions/workflows --jq ...`.

## Adaptive polling

`armActionsTimer()` uses `setTimeout` and re-arms after every poll (not
`setInterval`), because the delay changes with state:

- any tracked run `in_progress` or `queued` → **10s**
- otherwise → `intervalSec` (min 30, default 60)

That gives near-real-time completion feedback during a deploy without
polling hard while everything is idle.

## Banner

`#actions-badge` inserted at `index.html:1004`, between `#pr-badge` and
`#summary-bar`, `flex-shrink:0` with a `border-top` like the PR badge.
Hidden (`display:none`) when disabled or nothing is tracked.

Summary text and class come from `actionsRollup(runs)`:

| condition | class | text |
|---|---|---|
| poll error | `err` | `⚙ Actions — check failed` |
| any running | `running` | `⚙ N running · …` |
| any failed (none running) | `alert` | `⚙ N failed` |
| all good | (none) | `⚙ All N up to date` |

`#actions-dropdown` is `position:fixed` and opens upward, positioned off the
badge rect exactly like `#pr-dropdown`. One row per tracked workflow: repo ·
workflow name, a state pill, branch, actor, relative time. Row click →
`openUrl` with the run's `html_url`; a workflow with no runs yet shows a
`never run` row and links to the workflow page.

State colors follow the existing palette: green `#a6e3a1` success, red
`#f38ba8` failure, blue `#89b4fa` running (pulsing), grey cancelled/skipped,
orange `#fab387` for a per-row fetch error.

## IPC

No `preload.js` change — everything multiplexes on `msg.type`.

Renderer → main: `saveActionsSettings`, `listWorkflows`, `pollActionsNow`.
Main → renderer: `actionsList`, `workflowList`.

## Testable core

Pure helpers go in `actions-core.js` with a sibling `actions-core.test.js`
run by bare `node` (`assert`), matching the `ghost-core` precedent:

- `parseWorkflowInput(str)` → `{ repo, file } | { repo } | null` — the paste box parser.
- `runState(run)` → `'running' | 'success' | 'failure' | 'cancelled' | 'none'`.
- `actionsRollup(rows)` → `{ cls, text }` for the badge.
- `nextPollDelay(rows, intervalSec)` → ms.

## Out of scope

Re-run / cancel buttons (needs write scope), desktop notifications, run
history beyond the latest run, per-branch filtering.
