<p align="center">
  <img src="webview/banner.png" alt="Pixel Agents" width="500" />
</p>

<h1 align="center">Overlord</h1>

<p align="center">
  <strong>A desktop app for managing multiple Claude Code agents simultaneously.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/electron-33.4-blue?logo=electron" alt="Electron" />
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="Platform" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License" />
</p>

---

Overlord lets you spawn, monitor, and manage dozens of [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions from a single window. Each agent gets its own terminal, status tracking, and conversation history — so you can run parallel tasks across multiple projects without juggling terminal tabs.

<p align="center">
  <img src="webview/Screenshot_v1.1.jpg" alt="Overlord Office View" width="600" />
</p>

## Features

**Agent Management**
- Create agents on any project folder, each running an independent Claude Code session
- Auto-assigned names, customizable icons, rename support
- Restart, duplicate, or close agents with one click
- Crash recovery with automatic resume (up to 3 retries)
- Session persistence — all agents restore on app restart

**Real-time Monitoring**
- Live status indicators: active, waiting, permission request, crashed
- Spinner text extraction — see what Claude is doing right now (e.g. "Searching code", "Running bash")
- Tool usage tracking per agent with start/done states
- Context window usage bar with warnings at 75% and 90%
- Token counts, cost estimates, and model detection (Opus/Sonnet/Haiku)

**Integrated Terminal**
- Full xterm.js terminal per agent with interactive I/O
- Resizable panel (bottom or right layout)
- In-terminal search (Ctrl+F)
- Clickable file paths and URLs
- Clipboard image paste for sharing screenshots with agents
- Catppuccin Mocha color theme

**Teams**
- Group agents into teams with a lead agent and members
- Task tracking per team
- Coordinated multi-agent workflows

**Search & History**
- Global search across all agent conversations (Ctrl+Shift+F)
- Session history browser — resume any past Claude session (Ctrl+H)
- Agent timeline view with full conversation replay (Ctrl+T)
- Filter agents by name, project, or status

**Project Organization**
- Agents auto-group by working directory
- Collapsible project groups
- Localhost server detection with quick-open badges
- Server restart/remove via context menu
- `@agent` mentions to inject context from one agent into another

**Developer Experience**
- Keyboard-driven workflow (40+ shortcuts)
- Auto-compact detection — accepts context compaction prompts automatically
- Permission bypass mode for unattended operation
- Usage tracking with hourly/daily/weekly rate limit display
- Zoom controls

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+N` | New agent |
| `Ctrl+W` | Close agent |
| `Ctrl+R` | Restart agent |
| `Ctrl+D` | Duplicate agent |
| `Ctrl+L` | Clear terminal |
| `Ctrl+Tab` | Next agent |
| `Ctrl+Shift+Tab` | Previous agent |
| `Ctrl+!` | Jump to permission request |
| `Ctrl+F` | Find in terminal / filter agents |
| `Ctrl+Shift+F` | Search all conversations |
| `Ctrl+H` | Session history |
| `Ctrl+T` | Toggle timeline |
| `Ctrl+U` | Refresh usage stats |
| `Ctrl+Shift+W` | Close all idle agents |
| `?` | Show all shortcuts |

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated

### Install & Run

```bash
git clone https://github.com/YanayLLS/Claude-Overlord.git
cd Claude-Overlord
npm install
npm start
```

On Windows, you can also use `start.bat` which handles dependency installation automatically.

### Development

```bash
npm run dev       # Run with auto-restart on file changes
npm run package   # Build portable executable
npm run dist      # Build distributable installer
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Desktop framework | Electron 33 |
| Terminal emulation | xterm.js 5.5 |
| Process management | node-pty |
| Build tooling | esbuild, electron-builder |
| Theme | Catppuccin Mocha |

## How It Works

Overlord spawns each agent as a `claude --session-id <uuid>` process via node-pty. It watches the corresponding JSONL conversation files that Claude Code writes, parsing them in real-time to extract:

- User prompts and assistant responses
- Tool calls and their results
- Token usage and context window stats
- Server URLs, crash states, and permission requests

All state is persisted to `~/.pixel-agents/overlord-state.json` and restored on launch, including agent sessions, custom names, team configurations, and settings.

## License

MIT
