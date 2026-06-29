# PR Notifications — Design

**Date:** 2026-06-29
**Status:** Approved

## Goal

Notify every teammate using Overlord, via the top bar, when a new PR is opened
across watched GitHub repos — so they can jump to GitHub and approve it. Clicking
a PR opens it in the browser.

## Key decision: GitHub is the shared backend

No server, no sync layer. Each Overlord client polls GitHub independently via the
`gh` CLI. State ("which PRs has this user already seen") is per-client. GitHub is
the single source of truth all clients read.

`gh` cannot push events, so freshness comes from polling on a timer. Authenticated
`gh` allows 5000 requests/hour, so polling a handful of repos every 60s is trivial.

## Data flow (main.js)

1. Timer every `intervalSec` (default 60). Skip entirely if PR notifications disabled
   or no repos configured.
2. For each configured `owner/repo`, run:
   `gh pr list --repo owner/repo --state open --json number,title,url,author,isDraft,createdAt`
3. Filter out drafts. Aggregate across all repos into one list, each entry keyed by
   `owner/repo#number`.
4. Diff current keys against persisted `seenPRs` set:
   - Keys present now but not in `seenPRs` → **new PRs** → fire one desktop
     notification per new PR (reuse existing native notification infra).
   - Update `seenPRs` to the current set of open keys (drop keys for closed/merged PRs
     so a reopened number can notify again — acceptable edge).
5. Push the full open-PR list to the renderer over the existing IPC `send()` channel
   (new message type `prList`).

## Renderer (top bar)

- Badge injected into `#headerBadges`: shows `⬡ <count>` of open non-draft PRs.
  Hidden when count is 0.
- Click badge → dropdown panel listing each PR: `repo #123 · title · @author`.
- Click a PR row → `shell.openExternal(url)` (via IPC to main) opens it in the
  default browser.

## Settings (existing settings modal)

- Checkbox: **Enable PR notifications**.
- Textarea: **Watched repos**, one `owner/repo` per line.
- Number input: **Poll interval (seconds)**, min 30, default 60.

All persisted; changes take effect on next tick (or immediately re-arm the timer).

## Persistence (overlord-state.json)

Add to `settings` (or a sibling block):
- `prSettings`: `{ enabled: bool, repos: string[], intervalSec: number }`
- `seenPRs`: `string[]` of `owner/repo#number` keys.

## Error handling (quiet — never spam)

- `gh` not found or not authenticated → badge shows `⬡ !` with a tooltip explaining
  the cause; log once (not every tick); keep retrying on the timer.
- Network / transient `gh` failure → keep the last known PR list, retry next tick.
  Do not clear the badge or fire notifications.

## Edge cases

- **First poll after enabling / adding a repo:** seed `seenPRs` with all currently
  open keys *silently* — no flood of toasts for PRs that already existed.
- **Draft → ready:** a PR that flips out of draft appears as a new key (it was never
  seen as non-draft) and notifies. Desired.
- **Closed/reopened:** key dropped from `seenPRs` on close; reopen re-notifies.
  Acceptable.

## Out of scope (YAGNI — add when asked)

- Real-time push / webhooks (needs a server).
- Org-wide auto-discovery of repos.
- Per-user "review requested" filtering.
- Approving / merging from inside Overlord.
- PAT or OAuth auth (gh CLI only).
