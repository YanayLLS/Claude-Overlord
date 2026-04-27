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
- **Search** — Search across all conversations (Ctrl+Shift+F) or browse past sessions (Ctrl+H)
- **Timeline** — Full conversation replay per agent (Ctrl+T)
- **Auto-compact** — Automatically accepts context compaction prompts
- **Permission bypass** — Optional unattended mode
- **Usage stats** — Hourly/daily/weekly rate limit display

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
| `Ctrl+F` | Find in terminal / filter agents |
| `Ctrl+Shift+F` | Search all conversations |
| `Ctrl+H` | Session history |
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
