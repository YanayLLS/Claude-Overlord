# Lightweight Overlord — plan (2026-10-23)

Goal: less RAM, less idle CPU/GPU, fewer background network calls and process spawns, no feature loss.
Source: four read-only surveys (main, renderer, pty/bundles, feature modules) + live process table
(main 183 MB, renderer 178 MB, GPU 153 MB with more CPU time than the renderer, pty-host 109 MB with
13 leaked headless conhost.exe, warm spare claude ~250-400 MB).

## Work split (files are disjoint per owner)

### Owner: lead (main.js, pty-host.js, api-cost.js, gh-cache.js, bg-core.js, browser/registry.js, package.json, scripts/bundle-md.js)
- M1 warm spare expires after 10 min unadopted; spare output buffer capped.
- M2 terminal output buffers: chunk list + length instead of `str += d; slice` per chunk.
- M3 JSONL: keep fs.watch + fs.watchFile(1 s); the main-thread setInterval becomes a 5 s fallback.
- M4 5 s `stats` broadcast sends only agents whose stats changed; skipped while the window is hidden/minimized.
- M5 scanTeams: bail when no live agent could be a lead; 3 s → 10 s.
- M6 autoUpdater / checkGitUpdate: 60 s / 5 min → 30 min; electron-updater required lazily.
- M7 API-cost scan at most every 10 min; per-file cache prunes files older than the window.
- M8 PR watch 10 s → 30 s, check watch 30 s → 60 s; both skip while hidden/minimized.
- M9 protectClaudeConfig: skip the ~/.claude.json parse when its mtime and the worktree list are unchanged.
- M10 gh-cache MAX_ENTRIES 600 → 150.
- M11 bg-core seenNotices keyed by hash, capped at 200.
- M12 overlord.log rotates at 5 MB.
- M13 probeServers skips while hidden/minimized.
- M14 dev-server detection no longer creates a hidden browser renderer per agent: the URL is primed in the registry and loaded on first show / first MCP browser call.
- P1 pty-host reaps what node-pty leaks on natural exit: the conout worker isolate and the headless conhost.exe (attributed by spawn time; never one that could belong to a live pty).
- K1 installer excludes node-pty build junk (pdb/iobj/obj/deps, foreign prebuilds), package-lock; addon-web-links moves to devDependencies (it is bundled).
- K2 md-bundle: highlight.js core + 12 languages instead of lib/common (218 KB → ~80 KB).

### Owner: renderer agent (index.html, theme.css, tooltip.js, pr-fire.js, docs-ui.js)
- R1 `stats` message: skip render when unchanged; 30 s usage tick updates the summary bar only (if cheaply separable).
- R2 `body.bg` class on blur/visibilitychange pauses every CSS animation; pr-fire RAF, blinkCaret, status-meta ticker and the mention overlay stop while hidden/blurred.
- R3 box-shadow keyframes (upd-ring, upd-ping, pr-foot-glow, pr-chip-glow, needs-answer-flash) → opacity on a pseudo-element.
- R4 tooltip MutationObserver ignores nodes inside `.xterm`.
- R5 backdrop-filter on `#term-scroll-nav` → solid background.
- R6 md-bundle.js + world.css lazy-loaded on first use.
- R7 scrollback 10000 → 4000.
- R8 small leaks: pastedImages on agentClosed, prHeatMs prune, setup ticker cleared.
- R9 `:has()` on body → class toggle.

### Owner: releases agent (releases-main.js)
- B1 modal closed: refresh 5 → 15 min, deploy re-read 60 s → 3 min (10 s → 30 s while deploying), signPing 30 s → 60 s when nothing in flight, scanStray 90 s → 5 min.
- B2 persist() debounced 2 s, skipped when unchanged.

## Verification
`node --test` green; new tests for every pure change; version bump (minor); one commit.
Not done (needs a running instance, which this session must not launch): live before/after memory numbers.
