# Worktree Agents + Per-Worktree Dev Servers — Design

**Date:** 2026-07-15
**Status:** Approved, implementing

## Goal

Let multiple agents (or groups of agents) work on separate features simultaneously, each in its own git worktree, without one agent overwriting another's files, and let the user open a PR from one worktree's branch into `dev` without dragging in other worktrees' changes. Optionally, run each worktree's dev server concurrently on its own port (e.g. `https://lvh.me:5180`, `https://lvh.me:5190`).

## Why worktrees

A git worktree is a second working directory backed by the same `.git`, checked out to a different branch. In Overlord, **the agent's `cwd` is already the universal grouping key** (`index.html:1763` groups agents by `cwd`; `_groupServers`, `agentOrderMap`, `collapsedGroups`, `knownProjects` are all cwd-keyed). Therefore a worktree — being a distinct `cwd` — renders as its own group card **for free**. The main checkout stays on the user's branch; agents in a worktree can never touch the main working tree.

Verified worktree-safe (2026-07-15): `Designs`, `back-office`, `frontline.io-web` — no submodules, no nested repos, `file:` deps are tracked dirs.

## Data model

Stored in the existing free-form `settings` bag (`main.js:2292` does `Object.assign` — no migration):

```jsonc
settings.projects: {
  "C:\\Work\\Designs": {
    devCommand: "npm run dev:local:remote-back",   // prefilled by detection, editable
    urlTemplate: "https://lvh.me:{port}",
    basePort: 5170,                                  // first worktree base
    portStep: 10,                                    // spacing between worktrees
    seedFiles: [".env.local", ".env.localdb", ".certs"]  // gitignored files to copy in
  }
}

settings.worktrees: [{
  path:   "C:\\Users\\yanay\\.overlord\\worktrees\\Designs\\feat-login",  // = the cwd/group key
  repo:   "C:\\Work\\Designs",     // main checkout it was cut from
  branch: "feat/login",
  base:   "dev",                   // fork point + PR target
  port:   5180,                    // assigned base, sticky
  status: "ready" | "setup" | "failed"
}]
```

Location: central dir `~/.overlord/worktrees/<repo-name>/<branch-slug>` (keeps `C:\Work` clean). Group label shows `Designs ⑂ feat/login`, not the ugly path.

## Flows

### Create worktree
Project group `⋮` → **New worktree** → dialog: branch name + base branch (default `dev`, dropdown populated from `git branch -r`). Overlord:
1. `git -C <repo> fetch origin`
2. `git -C <repo> worktree add -b <branch> <central-path> origin/<base>`
3. Copy `seedFiles` from `<repo>` into `<central-path>` (the gitignored certs/env a fresh worktree lacks).
4. If `package.json` present, run install (pkg manager detected from lockfile: `package-lock.json`→npm, `pnpm-lock.yaml`→pnpm, `yarn.lock`→yarn), streamed into a visible terminal. Group shows *Setting up…*; `+ Agent` is live throughout.

New group appears immediately (status `setup` → `ready`).

### Add agents
Existing per-group `+ Agent` (`index.html:1821`) already reuses the group's cwd. Zero new code — agents land in the worktree.

### Dev server (optional, off by default)
Port contract: Overlord assigns each worktree a **base port** = `basePort + portStep * index`, injects `PORT=<base>` into the launcher's PTY env (the seam is `main.js:898/995`, env is already customized there). A repo needing >1 port derives them as `PORT+1`, `PORT+2`; `portStep: 10` guarantees no cross-worktree collision. Overlord tracks only the base (URL + badge).

Group `⋮` → **Start server**: first time per project, one dialog collects `devCommand` / `urlTemplate` / `basePort` (prefilled by detecting `start.bat`, `compose*.yaml`, or the `dev` script + vite/next deps). Overlord spawns `devCommand` in its own PTY at the worktree cwd with `PORT` injected, then registers `urlTemplate` (with `{port}` filled) into the existing `serverPorts` map (`main.js:126`) → the existing localhosts badge, Open-in-browser, Restart, and Kill (`killPortProcess` `main.js:278`) all work unchanged. Start/Stop/Restart in the group menu.

Repos need a one-time edit to read `PORT` (documented per repo below). Until edited, a repo falls back to its hardcoded port → only one worktree of it runs a server at a time. Opt-in per repo.

### Create PR
Worktree group `⋮` → **Create PR** → `gh pr create --base <base> --head <branch> --fill` run at the worktree cwd. Only that branch's commits go up. PR then appears in the existing PR panel; because the worktree knows its branch, its PR row can be linked back to the group (first agent↔PR link).

### Remove worktree
Group `⋮` → **Remove worktree** (confirm) → close its agents, stop its server, `git worktree remove <path>`, offer to delete the branch.

## Per-repo port edits (user's repos, done in those repos)

- **Designs** — `scripts/dev-local.mjs` + `vite.config.ts`: `server.port = Number(process.env.PORT) || 5173`; BFF listens on `PORT+1`; SPA proxy `BFF_URL` default → `http://localhost:${PORT+1}` (config already reads `env.BFF_URL` at `vite.config.ts:504`). lvh.me/TLS unchanged.
- **back-office** — `vite.config.mjs` + `start.bat`: API server on `PORT`, Vite client on `PORT+1`; the ~15 proxy targets `http://localhost:80` → `http://localhost:${PORT}`.
- **frontline.io-web** — compose: `COMPOSE_PROJECT_NAME=<branch>` to isolate container/network names, host port maps read `${PORT}`, `${PORT+n}`.

## Code shape

`main.js` is already 2791 lines. New code lands in two modules, not more sprawl:

- **`worktree.js`** — first `git` usage in the codebase; follows the existing `execFile('gh', …)` pattern (`shell: win32`, `windowsHide: true`). Exports: `createWorktree`, `listWorktrees`, `removeWorktree`, `copySeedFiles`, `runInstall`, `detectPackageManager`, `listRemoteBranches`.
- **`devserver.js`** — port allocation, server PTY lifecycle, feeds `serverPorts`.

`main.js` gains IPC cases: `createWorktree`, `removeWorktree`, `listRemoteBranches`, `saveProjectConfig`, `startDevServer`, `stopDevServer`, `createPr`. Each persists via the settings bag / emits an existing-style `send({type})`.

`index.html` gains: a "New worktree" modal, a project-config modal (dev server fields), and group-menu items (New worktree / Start server / Stop / Create PR / Remove worktree). Worktree groups get the `⑂ branch` label + port badge; reuse existing group/badge rendering.

## Out of scope (v1)

Auto-start servers on launch · ahead/behind + dirty badge · moving an existing agent into a worktree · multi-service single-command orchestration beyond what the repo's own launcher does · non-git projects.
