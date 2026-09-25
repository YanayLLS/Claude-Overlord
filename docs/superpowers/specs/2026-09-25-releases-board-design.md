# Releases board — design

**Date:** 2026-09-25
**Status:** approved in chat, awaiting spec review

## Problem

A team with many repos, each using branch-per-environment deploys (merge to `dev` deploys dev, merge to
`master`/`prod-one`/`main` deploys prod), has no single place that answers:

- What is in each environment of each repo right now?
- How much is waiting to be promoted to the next environment?

Every repo names its environment branches differently, so the answer lives in people's heads.

## Goal (layer 1 of 3)

A read-only board in Overlord: one row per repo, one column per environment. Each cell shows the tip of
that environment's branch. Each cell also shows how many commits are waiting to move to the next
environment on the promotion path.

**"Deployed" means merged into the environment branch.** It does not mean a successful deploy run. The
board shows no CI status.

Generic: any company describes its repos in one JSON config. Frontline's config is the default source.

### Non-goals (later layers, not this spec)

- Grouping pending PRs by ticket ID across repos ("Waiting for prod" view).
- Promote or deploy buttons.
- An environment-file / GitOps deploy model.
- Background polling while the board is closed.

## Config

### Source

`settings.releasesSettings.source` is one of:

- An absolute local path to a `.json` file.
- `owner/repo:path[@ref]`, fetched with `gh api repos/{owner}/{repo}/contents/{path}?ref={ref}` and
  `Accept: application/vnd.github.raw`. Without `@ref` the repo's default branch is read.

The default is `LLSLtd/frontlineio-frontend:.overlord/releases.json@dev`.

- The Overlord repo is public, so Frontline's structure is not baked into it. Only this pointer is.
- The file lives in the private Designs repo (`frontlineio-frontend`). Everyone with access shares one
  file.
- A user without access gets a 404. The board then shows the setup screen: "No releases config — set a
  source in Settings", with a link to an example config.

### Schema

```json
{
  "envs": ["dev", "alpha", "staging", "prod"],
  "repos": [
    {
      "repo": "LLSLtd/frontline.io-web",
      "label": "frontline.io-web",
      "branches": { "dev": "dev", "alpha": "alpha", "staging": "staging", "prod": "prod-one" },
      "promote": ["dev", "alpha", "prod"]
    },
    { "repo": "LLSLtd/servers-infrastructure", "note": "Applied by hand — dev = prod tfvars" }
  ]
}
```

| Field | Rule |
|---|---|
| `envs` | Non-empty array of unique non-empty strings. It sets the column order. |
| `repos[].repo` | `owner/name`, same regex as `actions-core.js` `REPO_RE`. |
| `repos[].label` | Optional display name. Defaults to the name part of `repo`. |
| `repos[].branches` | Env → branch name. Keys must be in `envs`. A missing env is an empty cell. |
| `repos[].promote` | Optional. An ordered list of envs, each a key of `branches`, at least 2 entries. Each consecutive pair gets a "waiting" count. |
| `repos[].note` | Replaces the cells with one line of text. The row needs `branches` or `note`, not both. |

Validation returns every problem at once, each with a path (`repos[3].promote[1]: "qa" is not in
branches`). An invalid config shows that list instead of the grid.

## Data

One GraphQL query per refresh, sent through the existing `ghGraphql` helper, covers every repo.

- **Per cell:** `ref(qualifiedName: "refs/heads/<branch>") { target { ... on Commit } }`, giving sha,
  headline + body, author, committedDate and url.
  - A merge commit's "Merge pull request #N from …" headline is replaced with `#N <PR title>`, taken
    from the first line of the body.
- **Per promote pair `(from → to)`:** `ref(<to branch>) { compare(headRef: <from branch>) { aheadBy
  commits(last: 10) } }`.
- A missing branch comes back as a null ref rather than an error, so it only marks its own cell.

**Failures:**

- `gh` missing or not logged in: the panel shows the same error the Actions feature shows (reuse its
  error codes).
- A per-request failure only marks that cell or arrow. A 404 on a branch shows "branch missing". Other
  errors show `!` with the message on hover. The rest of the grid renders.

**Refresh:**

- Refreshes when the panel opens, on the ⟳ button, and every 5 min while the panel stays open.
- No polling while it is closed.
- The last result is cached in `settings.releasesCache` so the panel opens instantly with stale data and
  an "updated HH:MM" stamp. `publicSettings()` excludes it, as it does `actionsCache`.

## UI

- **Badge:** a "Releases" badge in the sidebar footer, next to the PR and Actions badges. It has the same
  styling and opens the panel.
- **Panel:** a modal grid.
  - The header has "updated HH:MM" and ⟳.
  - The first column is the repo label, then one column per env.
  - A cell shows `sha7 · age`, the author, and the branch name dimmed underneath.
  - When the cell's env has a next step in `promote`, it adds `N → <next env>`, linking to the GitHub
    compare. N = 0 shows dimmed as "in sync".
  - A `note` row spans all env columns.
- **Cell detail** (click a cell) shows:
  - the full commit title, author and time, linked to the commit
  - the list of pending commits for its outgoing promote pair (up to 10, then "…and N more" linking to
    the compare)
- **Setup screen:** shown when there's no config, a 404, or an invalid config. It shows the source in
  use, the problem, and the validation list when there is one.

## Code

Same split as the Actions feature (`actions-core.js`):

| File | Role |
|---|---|
| `releases-core.js` | Pure: `parseSource`, `validateConfig`, `buildGrid(config, results)` → rows/cells/arrows view model, `age()`. No DOM, no gh. |
| `releases-core.test.js` | `node --test`. Covers validation errors, source parsing, and grid building incl. missing branches, notes, non-adjacent promote steps, per-cell errors. |
| `releases-main.js` | Loads the config (file or gh), fans out requests, sends `{ type: 'releases', state }`; source + cache in `<stateDir>/releases.json`, not `settings`. Handles `releasesRefresh`, `releasesOpen`/`Close` (start/stop 5-min timer). |
| `releases-ui.js` + `releases.css` | Badge, modal, cell detail, setup screen (which also holds the source field — not in Settings, for isolation). |
| `main.js` / `index.html` | Hooks only: 2 and 3 lines. Removing the feature = delete `releases-*` + those lines. |

## Frontline default config

Commit `.overlord/releases.json` to `frontlineio-frontend` on a branch and open a PR to `dev` after the
user says push (per that repo's rules). It is a mirror of `docs/rules/branches-and-pr-base.md`:

```json
{
  "envs": ["dev", "alpha", "staging", "prod"],
  "repos": [
    { "repo": "LLSLtd/frontlineio-frontend",
      "branches": { "dev": "dev", "alpha": "alpha", "staging": "staging", "prod": "master" },
      "promote": ["dev", "alpha", "prod"] },
    { "repo": "LLSLtd/frontline.io-web",
      "branches": { "dev": "dev", "alpha": "alpha", "staging": "staging", "prod": "prod-one" },
      "promote": ["dev", "alpha", "prod"] },
    { "repo": "LLSLtd/identity-server",
      "branches": { "dev": "dev", "prod": "main" },
      "promote": ["dev", "prod"] },
    { "repo": "LLSLtd/back-office",
      "branches": { "dev": "dev", "prod": "master" },
      "promote": ["dev", "prod"] },
    { "repo": "LLSLtd/AI-chat-front",
      "branches": { "staging": "staging", "prod": "prod-one" },
      "promote": ["staging", "prod"] },
    { "repo": "LLSLtd/remote-support-web",
      "branches": { "staging": "staging", "prod": "prod-one" },
      "promote": ["staging", "prod"] },
    { "repo": "LLSLtd/Websocket",
      "branches": { "prod": "master" } },
    { "repo": "LLSLtd/dbschemas",
      "note": "Publishes to npm on every push to dev — not an environment" },
    { "repo": "LLSLtd/servers-infrastructure",
      "note": "Applied by hand — dev branch = prod tfvars" }
  ]
}
```

Designs' rules say `back-office` master is deployed by hand in prod. The board still shows its `master`
tip, because "deployed = merged" is the team's definition.

## Testing

- **Unit:** `releases-core.test.js`, written test-first. It includes a test that validates the Frontline
  config above as-is.
- **Manual:** run Overlord against the real default source and check each row against `gh` by hand for
  two repos. Also check the setup screen with a bogus source.
