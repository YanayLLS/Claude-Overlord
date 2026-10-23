# Claude Overlord

A desktop app for running and managing multiple [Claude Code](https://docs.anthropic.com/en/docs/claude-code) agents at once.

Each agent gets its own terminal session, live status tracking, and conversation history. Spawn agents across different projects, monitor what they're doing in real time, and switch between them instantly.

## Features

- **Multiple agents** — Run as many Claude Code sessions as you need, each in its own terminal
- **Live status** — See which agents are active, waiting, requesting permission, or crashed
- **Tool tracking** — Watch tool calls happen in real time with spinner text extraction
- **Context bar** — Per-agent context window usage with warnings at 75%/90%
- **Token & cost tracking** — Input/output tokens, cache stats, cost estimates, model detection
- **Crash recovery** — Automatic resume on crash (up to 3 retries)
- **Session persistence** — All agents restore when you restart the app
- **Teams** — Group agents with a lead and members for coordinated work
- **Server detection** — Auto-detects localhost URLs from agent output, with restart/remove menu
- **@mentions** — Reference one agent's context inside another
- **Search** — Search across all conversations (Ctrl+Shift+F)
- **Timeline** — Full conversation replay per agent (Ctrl+T)
- **Auto-compact** — Automatically accepts context compaction prompts
- **Permission bypass** — Optional unattended mode
- **Usage stats** — Hourly/daily/weekly rate limit display
- **Markdown documents** — A Docs column beside the terminal (Ctrl+Shift+D) shows `.md` files as tabs, rendered GitHub-style: code highlighting, tables, task lists, right-to-left paragraphs, relative images and links, outline, find, and live reload whenever a file changes on disk. When the focused agent writes a file that is already open, its tab comes to the front, so a plan can be read while the agent writes it. Files you never opened stay closed. Open a file by double-clicking it (the installer registers the `.md` association; Settings → General does it for a copy run from source), with "Open with → Overlord", by dragging it anywhere into the window, or with the column's + button. The same + starts a **quick note**: a new `.md` in `~/.overlord/notes`, opened for writing. Any document can be edited in place (Ctrl+E, or the pencil): the raw markdown replaces the rendering and every keystroke is saved to the file.

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+N` | New agent |
| `Ctrl+W` | Close agent |
| `Ctrl+R` | Restart agent |
| `Ctrl+D` | Duplicate agent |
| `Ctrl+L` | Clear terminal |
| `Ctrl+Tab` | Next agent |
| `Ctrl+Shift+Tab` | Previous agent |
| `Ctrl+!` | Jump to next permission request |
| `Ctrl+F` | Find in terminal / document / filter agents |
| `Ctrl+Shift+D` | Show / hide the Docs column |
| `Ctrl+W` / `Ctrl+Tab` (Docs column clicked last) | Close / next document tab |
| `Ctrl+E` (Docs column) | Edit the markdown in place; `Ctrl+S` saves (unsaved tabs show ●, closing one asks first); `Esc` returns to the rendering |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` (Docs column) | Document text size |
| `Ctrl+Shift+F` | Search all conversations |
| `Ctrl+T` | Toggle timeline |
| `Ctrl+U` | Refresh usage stats |
| `Ctrl+Shift+W` | Close all idle agents |
| `?` | Show all shortcuts |

## Install

Download the latest installer from [Releases](https://github.com/YanayLLS/Claude-Overlord/releases). Run `Overlord Setup x.x.x.exe` — no admin required. The app installs to your user profile and auto-updates when new versions are published.

> Windows will show a SmartScreen warning on first install (app is unsigned). Click **More info → Run anyway**.

## Run from source

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- macOS/Linux: Xcode Command Line Tools or `build-essential` + `python3` (for node-pty)

### Quick Start

**Windows:**
```
git clone https://github.com/YanayLLS/Claude-Overlord.git && cd Claude-Overlord && start.bat
```

**macOS / Linux:**
```
git clone https://github.com/YanayLLS/Claude-Overlord.git && cd Claude-Overlord && npm install && npm start
```

Double-click `start.bat` any time to launch on Windows.

### Development

```bash
npm run dev       # Auto-restart on file changes
npm run package   # Build unpacked app (no installer)
npm run dist      # Build NSIS installer + publish assets
```

## How It Works

Each agent is a `claude --session-id <uuid>` process managed via node-pty. Overlord watches the JSONL files Claude Code writes and parses them in real time to extract prompts, tool calls, token usage, server URLs, and status changes. State is saved to `~/.pixel-agents/overlord-state.json` and restored on launch.

## Stack

Electron, xterm.js, node-pty, esbuild.
