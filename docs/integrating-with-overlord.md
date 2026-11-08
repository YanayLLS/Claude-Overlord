# Integrating with Overlord — brief for an agent

You are writing (or acting as) a program that talks to **Overlord**, a desktop app on this computer that runs many Claude Code agents. Overlord exposes a local API so you can list its agents, start new ones, send them prompts, wait for their replies, answer their permission prompts and questions, read and post in peer chat, and react to events.

Everything below is on the **same machine only** (127.0.0.1). Nothing is reachable from the network.

## 1. Connect

1. Read `~/.overlord/api.json` (Windows: `%USERPROFILE%\.overlord\api.json`):
   ```json
   { "apiVersion": 1, "pid": 12345, "port": 7790,
     "baseUrl": "http://127.0.0.1:7790/v1", "mcpUrl": "http://127.0.0.1:7790/mcp",
     "eventsUrl": "http://127.0.0.1:7790/v1/events", "token": "…" }
   ```
   - The file exists only while Overlord runs with **Settings → Local API** turned on. If it's missing, tell the user to turn that on. Don't guess a port.
   - Read it again on every connect and after any `401` or connection error. The port and token can change between runs.
2. Send `Authorization: Bearer <token>` on every request. `GET /v1/health` is the one exception: it needs no token and answers `{ ok, apiVersion }`.
3. Call **`overlord_capabilities`** first and plan from its answer, not from this file. It lists every tool with its JSON Schema, every event type, limits, and feature switches. If `apiVersion` isn't `1`, stop and report it: the contract changed.

The token can do anything the user can do in Overlord, including approving shell commands. Never log it, print it, commit it or send it anywhere other than 127.0.0.1.

## 2. Two ways to call

**REST.** `POST {baseUrl}/<tool>` with the arguments as a JSON body (`{}` when there are none). The answer is the result as JSON. Errors come back as `{ "error": "…" }` with one of these statuses:

| Status | Meaning | What to do |
|---|---|---|
| 400 | Bad or unknown argument | Fix the call. The schema is in `overlord_capabilities`. |
| 401 | Missing or wrong token | Re-read `api.json` and retry once |
| 404 | No such agent, conversation, webhook or tool | Refresh with `agents_list` |
| 409 | The agent's state doesn't allow this (archived, nothing to answer, waiting on something else, peer offline) | Read the state with `agent_get`, then decide |

**MCP.** `POST {mcpUrl}` is a stateless MCP server (Streamable HTTP with JSON responses) offering the same tools. Example Claude Code `.mcp.json`:
```json
{ "mcpServers": { "overlord": { "type": "http", "url": "http://127.0.0.1:7790/mcp",
  "headers": { "Authorization": "Bearer <token from api.json>" } } } }
```
Over MCP, a failed call returns `isError: true` with the message as its text.

## 3. The model

- **Agent:** `{ id (number), name, title, cwd, status, pending, archived, sleeping, crashed, createdAt, sessionId, model }`.
  - `status` is `active` (working) or `waiting` (idle at its prompt).
  - `pending` is `null`, `permission` (a tool-approval dialog is open) or `question` (an `AskUserQuestion` is open).
  - While `pending` is set, the agent is blocked on a human, which means you.
  - `sleeping` is true when CPU saving closed its CLI because it sat idle and nobody had it open. It still counts as `waiting`. Sending it anything (`agent_send`, `agent_ask`, `agent_keys`) resumes the same session first, which adds a few seconds; `agent_wake` resumes it without sending anything.
- `agent_get` adds `lastPrompt`, `lastReply` (its last assistant message), `spinner`, open `tools`, the open `question` input, and `stats`.

## 4. Tools at a glance

| Goal | Tool |
|---|---|
| What can this Overlord do | `overlord_capabilities`, `overlord_info` |
| See agents | `agents_list` (`includeArchived?`), `agent_get` (`agentId`) |
| Start an agent | `agent_create` (`cwd`: an absolute path to an existing folder, `prompt?`). Returns `{ agentId }`. |
| Fire and forget a prompt | `agent_send` (`agentId`, `text`). It's queued until the agent is at its prompt. |
| Prompt and wait for the answer | `agent_ask` (`agentId`, `text`, `timeoutSec?` default 600, max 3600) |
| Read history | `agent_transcript` (`agentId`, `limit?`), `agent_screen` (`agentId`, `chars?`), which is the terminal as text |
| Unblock an agent | `permission_answer` (`decision`: `allow` \| `allow_always` \| `deny`, or `option` 1–9), `question_answer` (`options`: one 1-based number per question, or `text`) |
| Low-level control | `agent_keys` (raw keys: `"\r"` Enter, `"\u001b"` Esc, `"\u001b[B"` down arrow), `agent_interrupt` (Esc: stops the turn and drops queued sends) |
| Lifecycle | `agent_archive`, `agent_unarchive`, `agent_close`, `agent_wake` (resume a sleeping agent) |
| Peer chat (people and their Overlords on the LAN) | `chat_list`, `chat_read` (`peer` or `group`, `limit?`), `chat_send` (`peer` or `group`, `text`) |
| Events | `events_poll` (`since?`, `types?`, `timeoutSec?` max 60), `webhook_add` / `webhook_list` / `webhook_remove` |

## 5. Recipes

**Ask an agent something:**
1. Call `agent_get`. If `pending` isn't `null`, deal with that first (step 4), or `agent_ask` returns 409.
2. Call `agent_ask` with `{ agentId, text, timeoutSec }`. Set your HTTP client's timeout longer than `timeoutSec`. Many MCP clients cut calls off after a few minutes, so over MCP use a short `timeoutSec` and repeat.
3. Check the result:
   - `done: true` means `reply` is the agent's final message for that turn.
   - `done: false, pending: "permission" | "question"` means it stopped for you. `reply` holds whatever it said so far.
   - `timedOut: true` means it's still working. Don't send the prompt again. Wait for `agent.status` = `waiting` with `events_poll`, then read `agent_get().lastReply`.
   - `error` means it was closed, or the message couldn't be delivered.
4. To unblock an agent:
   - For a permission, read what it wants first: `agent_get` (open `tools`) or `agent_screen`. Then call `permission_answer`.
   - For a question, `agent_get().question` holds the questions and options. Call `question_answer`. A multi-question form can end on a review screen; send `agent_keys` `"\r"` when `agent_screen` shows one.
5. After you unblock it, the turn continues. Wait for `agent.status` = `waiting` with `events_poll`, then read `lastReply`. Don't call `agent_ask` again for the same request.

**Start a worker:**
1. Call `agent_create` with `{ cwd: "C:\\path\\to\\repo", prompt: "…" }`. The `prompt` is optional; you can also send prompts later with `agent_send` or `agent_ask`.
2. Then watch it the way the ask recipe does.

**React to agents needing a human.** Loop `events_poll` with `types: ["agent.pending", "agent.status"]` and pass the `seq` from the previous answer as `since`. On `agent.pending`, decide or alert the user.

**Live stream (non-MCP clients).** `GET {eventsUrl}?types=agent.,chat.` is Server-Sent Events: each event has `id: <seq>`, `event: <type>`, and `data: <json>`. To resume, send `Last-Event-ID: <seq>`. Overlord keeps the last 1000 events.

**Webhooks.** Call `webhook_add` with `{ url: "http://127.0.0.1:<yourport>/path", types? }`. It returns `{ id, secret }`, and the secret is shown only this once.
- Overlord POSTs each event to your URL as JSON, in order, with `X-Overlord-Event` and `X-Overlord-Signature: sha256=<hex HMAC-SHA256(secret, raw body)>` headers.
- Check the signature and answer 2xx.
- Failed deliveries are retried after 1 s, 5 s and 25 s, then that event is dropped.
- Webhooks persist across restarts, so remove yours when you're done.

## 6. Events

Every event has `type`, `seq`, `at` (ISO time) and, for agent events, `agentId`.

| Type | Extra fields |
|---|---|
| `agent.created` | `cwd`, `name`, `sessionId` |
| `agent.closed`, `agent.archived`, `agent.unarchived`, `agent.crashed` | none |
| `agent.status` | `status` (`active` or `waiting`) |
| `agent.sleeping` | `sleeping` (`true`: CPU saving closed its CLI; `false`: resumed) |
| `agent.pending` | `kind` (`permission` or `question`) |
| `agent.pending_cleared` | none |
| `agent.question` | `input` (full `AskUserQuestion` input) |
| `agent.prompt` | `text` (a prompt reached the transcript) |
| `agent.message` | `text` (an assistant message) |
| `agent.title` | `title` |
| `agent.tool_start`, `agent.tool_done` | `toolId`, `tool`, `status` |
| `agent.send_failed` | `text` |
| `chat.message` | `conversation` (`{type: 'peer' or 'group', id}`), `group`, `message` |

Filter with exact types or prefixes ending in `.`, for example `agent.status,chat.`. `seq` restarts at 1 when Overlord restarts. If you send a `since` larger than the current `seq`, you get the whole buffer again, so dedupe by `(at, type, agentId)` if that matters to you.

## 7. Rules of conduct

- These are the user's agents. Don't close, archive or interrupt one you didn't start unless the user asked you to.
- **Permissions:** approve only what your task clearly covers, and read the request (`agent_screen`) before you answer. `allow_always` lasts for the rest of that agent's session, so prefer `allow`. When in doubt, leave the prompt open and tell the user; the dialog waits.
- **Rate:** don't poll `agent_get` in a tight loop. Use `events_poll` (long-poll), SSE or webhooks.
- **Feature switches:** check `features` in `overlord_capabilities`:
  - `peerChat: false` means the chat tools have no one to talk to.
  - `bypassPermissions: true` means agents rarely stop for permissions.
  - `cpuSaving: true` means idle agents get their CLI closed (`sleeping`) and the first message to one takes a few seconds longer.
