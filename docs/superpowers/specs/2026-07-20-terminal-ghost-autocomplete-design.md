# Terminal Ghost-Text Autocomplete — Design

**Date:** 2026-07-20
**Status:** Approved, pending implementation plan

## Goal

Copilot-style inline autocomplete for prompts typed into a live agent's
terminal ("chat"). As the user types a prompt to a running Claude Code agent,
a gray continuation appears inline after the cursor; **Tab** accepts it.
Visually identical to Claude Code's empty-input hint, but works *as you type*.

Claude Code has no native as-you-type prose completion and exposes no
hook/setting/API for one (verified). This is built entirely inside Overlord.

## Non-goals

- No completion inside `/`-command or `@`-file menus (Claude Code owns those).
- No multi-line block completion — current line only.
- Not the New Agent / New Team prompt boxes (may reuse the engine later; out of
  scope here).

## The two core moves (why it doesn't corrupt the terminal)

1. **Overlay, never buffer.** The suggestion is a separate absolutely-positioned
   `<span>` floated over the xterm canvas at the cursor's pixel coordinates,
   `pointer-events:none`. xterm's buffer is never written to, so it stays in
   perfect sync with the PTY. The overlay is pure decoration.
2. **Read prefix from the screen, not keystrokes.** On each keystroke we scrape
   the cursor's row from `terminal.buffer.active`, locate Claude Code's prompt
   marker, and take the text after it up to the cursor. Reading ground truth
   means history-recall, edits, and paste never cause drift.

## Components

### 1. Renderer — GhostText controller (one per xterm)
Wired into the existing `createXterm` (`index.html:~2397`). Responsibilities:

- **Trigger:** after the existing `terminal.onData` handler, schedule a
  debounced (350ms) `maybeSuggest(id)`.
- **`readPrefixFromRow(rowText, cursorX, markers)`** *(pure, tested)* — find the
  last prompt marker at/before the cursor on the row; return
  `{ prefix, ok }` where `prefix` is the text from marker→cursor. `ok:false`
  when no confident marker.
- **Request:** call `api.ghostComplete({ id, prefix, context })`.
- **Render:** compute cursor pixel position from xterm cell dimensions and
  `buffer.active.cursorX/cursorY`; position the overlay span, gray, terminal
  font.
- **`attachCustomKeyEventHandler`:**
  - **Tab** — *only when a suggestion is showing* — accept: send the
    continuation via the existing `termInput` channel, clear overlay, prevent
    Tab reaching Claude Code. No suggestion showing → Tab passes through.
  - **Esc** — dismiss overlay (Esc still passes through).
  - Any other key / cursor move / selection / scroll / blur / resize /
    agent-switch → clear overlay (recompute on next keystroke).

### 2. Main — IPC `ghostComplete(prefix, context)`
- Reuses `getApiKey()` and the existing messages-API `fetch` (`main.js:~326`).
- Model: `claude-haiku-4-5`. `max_tokens: 64`.
- **Context:** last ~40 lines of that agent's terminal output, so completions
  are aware of what the agent is doing.
- System prompt: return **only** the continuation of the current line — no
  quotes, no explanation; empty string if unsure.
- **`extractContinuation(prefix, modelText)`** *(pure, tested)* — strip any echo
  of the prefix the model repeated; return the continuation only.
- No key / network error / timeout (≤2s) → return empty string, silently.

### 3. Settings toggle
- `chk-ghost` "Prompt autocomplete" in the existing settings panel, persisted,
  **on by default**. Off → controller never fires.

## Guards (suppress unless ALL hold)

- A prompt marker is found on the cursor row (`ok:true`).
- Cursor is at end of the line.
- Prefix length ≥ 3.
- Agent is idle: no PTY output (`termData`) for that id in the last ~200ms
  (i.e. not mid-stream).
- Not inside a `/`-command or `@`-file context.
- Feature toggle on; API key present.

Plus: cache last `prefix → suggestion`; cancel in-flight request on new
keystroke; skip refetch if prefix unchanged.

Any guard failing → show nothing. **Degrades to invisible, never to garbage.**

## Data flow

```
keystroke → onData (unchanged, sends termInput)
         → debounce 350ms → readPrefixFromRow → guards
         → IPC ghostComplete(prefix, last40lines)
         → Haiku → continuation
         → position overlay <span> at cursor px
Tab (suggestion showing) → termInput(continuation) → PTY → clear overlay
```

## Error handling

- Missing API key → feature silently inert (mirrors existing early-return in
  `main.js`).
- Network error / timeout / unparseable row → no suggestion; typing never
  blocked (overlay is `pointer-events:none`, all work is async/debounced).

## Known ceiling (the flagged fragility)

Prompt-marker detection is a heuristic over a small marker list (`>`, `❯`, …).
If Anthropic reskins Claude Code's input box, the marker list needs a one-line
update. Contained to `readPrefixFromRow` and marked with a `ponytail:` comment
naming the upgrade path.

Second, minor: because the overlay floats above the canvas, a Claude Code
redraw landing mid-suggestion clears the gray text for ~one frame then it
repaints. Cosmetic blink in edge cases only.

## Testing

- **Pure/unit (assert-based, node, no framework):** `readPrefixFromRow` and
  `extractContinuation` — marker detection, cursor-at-end, prefix extraction,
  echo stripping, empty/unsure cases.
- **Live:** overlay alignment, Tab accept, guard suppression (mid-stream, menus,
  toggle off), missing-key inertness — verified in the running app.

## Versioning

Per project rule, the implementing commit bumps `package.json` (minor — new
feature).
