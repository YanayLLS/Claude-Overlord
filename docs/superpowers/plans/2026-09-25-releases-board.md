# Releases Board Implementation Plan

> **For agentic workers:** executed natively in the session that wrote it (user said "sure and implement").

**Goal:** A read-only board of repo × environment, showing each env branch's tip and the commits waiting
to be promoted, driven by a per-company JSON config.

**Architecture:** Four self-contained files. The host code only gets hooks: 2 lines in `main.js` and
3 lines in `index.html`. To remove the feature, delete the four files and those 5 lines.

**Tech Stack:** Electron main/renderer, `gh api` via the existing `ghJson`, `node --test`.

**Spec:** `docs/superpowers/specs/2026-09-25-releases-board-design.md`

## Global Constraints

- Isolation: no feature state in `settings`. The source and cache live in `<STATE_DIR>/releases.json`.
  - This changes the spec: the source field lives on the board's setup screen, not the Settings modal.
- Default source: `LLSLtd/frontlineio-frontend:.overlord/releases.json@dev`.
- Every string spliced into a `gh api` path passes a regex first:
  - repo: `REPO_RE`
  - branch, path and ref: `^[\w.\/-]+$` with no `..`
  - Needed because `ghJson` runs through a shell on Windows.
- Refresh only while the panel is open: on open, via ⟳, and every 5 min.

## Review Focus

1. A branch that doesn't exist (404): that cell shows "branch missing" and the rest renders.
2. A config with a bad env/branch/promote reference: every problem is listed with its path, and no
   requests are made.
3. A branch name with shell metacharacters (`dev&calc`): it's rejected by validation and never reaches gh.
4. A promote step between non-adjacent columns (identity `dev → prod`): the count shows in the dev cell,
   pointing at prod.
5. A source that isn't reachable (no repo access): the setup screen shows the error and lets the user
   change the source.

---

### Task 1: `releases-core.js` (pure)

**Files:** Create `releases-core.js` and `releases-core.test.js`.

**Produces:**
- `parseSource(str) → {kind:'file', path} | {kind:'gh', repo, path, ref} | null`
- `validateConfig(obj) → string[]` (an empty array means valid)
- `requestsFor(config) → {commits:[{repo,env,branch}], compares:[{repo,from,to,base,head}]}`
- `buildGrid(config, results) → {envs, rows:[{repo,label,note?,cells:[cell|null]}]}`
  - `results` = `{commits:{'repo|env':{sha,title,author,date,url}|{error}|{missing:true}}, compares:{'repo|from':{to,ahead,url,commits}|{error}}}`
- `age(isoDate, now) → '40m'|'2h'|'3d'|'5w'`
- `DEFAULT_SOURCE`, `SAFE_REF_RE`

Test-first: each review-focus case above, plus a check that the Frontline config from the spec validates.

### Task 2: `releases-main.js` + 2 hooks in `main.js`

**Produces:** `module.exports = ({ send, ghJson, stateDir }) => ({ handle(msg) → boolean })`.

It handles these messages:
- `releasesOpen`: sends the cached data, then refreshes and starts the 5-min timer.
- `releasesClose`: stops the timer.
- `releasesRefresh`
- `releasesSetSource`: validates with `parseSource`, saves, refreshes.

It sends `{type:'releases', state}`, where `state` =
`{source, updatedAt, grid?, problems?, error?, errorCode?, loading}`.

Hooks in `main.js`:
- a `require` after `ghJson`
- `if (releases.handle(msg)) return;` at the top of `handleIpc`

### Task 3: `releases-ui.js` + `releases.css` + 3 hooks in `index.html`

The script adds its own badge to `.foot-chips`, and builds the modal, cell detail and setup screen.

Hooks in `index.html`:
- `<link>`
- `<script>`
- one dispatch line in `api.on`: `if (msg.type === 'releases') return window.releasesUi && releasesUi.onMsg(msg);`

### Task 4: Frontline config in Designs

Add `.overlord/releases.json` to `frontlineio-frontend` on a new branch cut from `origin/dev`. Commit only;
push and open the PR when the user says so.

### Task 5: Verify + release

- `npm test`
- Launch the app and check the board against `gh` for two repos, plus the setup screen with a bogus source.
- Bump the minor version, then commit.
