# Overlord local API

Programs on the same computer can control Overlord: list and start agents, send prompts, ask an agent something and wait for the reply, answer its permission prompts and questions, read and post in peer chat, and get events as they happen.

Turn it on under **Settings → Local API**. It is off by default. When it is off, Overlord opens no port, writes no token file and fires no webhooks.

## Connecting

While the API runs, Overlord writes `~/.overlord/api.json` (`%USERPROFILE%\.overlord\api.json` on Windows):

```json
{
  "apiVersion": 1,
  "pid": 12345,
  "port": 7790,
  "baseUrl": "http://127.0.0.1:7790/v1",
  "mcpUrl": "http://127.0.0.1:7790/mcp",
  "eventsUrl": "http://127.0.0.1:7790/v1/events",
  "token": "…"
}
```

- Read the port and the token from this file every time you connect. The port is 7790 unless that port is taken, and **New token** in Settings replaces the token.
- If the file is missing, the API is off or Overlord isn't running. Overlord deletes the file when it quits.
- Every request needs the header `Authorization: Bearer <token>`. The only exception is `GET /v1/health`.
- Overlord listens on 127.0.0.1 only. It rejects any request whose `Host` header isn't `127.0.0.1`, `localhost` or `[::1]` with the right port.
- There are no CORS headers, so web pages in a browser can't read the responses.

A program that holds the token can do anything you can do in Overlord, including approving an agent's Bash commands. Treat the token like a password.

## Discovering capabilities

Call `overlord_capabilities` first (`POST /v1/overlord_capabilities` with `{}`, or the MCP tool of the same name). It returns:

| Field | Contents |
|---|---|
| `overlord.version`, `apiVersion` | The app version, and the API contract version. `apiVersion` goes up only on a breaking change. |
| `auth` | How to authenticate and where the token file is |
| `transports` | REST, MCP, SSE and webhooks: paths, resume rules, retry schedule, error codes |
| `features` | Switches that change what you will see: `peerChat` (peer connections on), `bypassPermissions` (agents skip permission prompts, so `agent.pending` with kind `permission` is rare), `remoteControl`, `cpuSaving` (idle agents nobody has open get their CLI closed; see `sleeping`) |
| `limits` | The longest `agent_ask` wait, how many events are buffered, the most webhooks allowed |
| `tools` | Every tool with its description and JSON Schema |
| `events` | Every event type with its description |

The `tools` and `events` lists are built from the same tables the server dispatches from, so a newer Overlord's new tools and events show up here with no client change.

## Calling tools (REST)

Each tool is `POST /v1/<tool>`, with the arguments as a JSON body. The response is the result as JSON.

| Status | Meaning |
|---|---|
| 400 | Bad arguments |
| 401 | Missing or wrong token |
| 404 | No such agent, conversation or tool |
| 409 | The agent isn't in a state that allows the call (for example, nothing to answer, or it is archived) |

Every error has the body `{ "error": "…" }`. `GET /v1/tools` lists every tool with its JSON Schema.

```sh
T=$(node -p "require(require('os').homedir()+'/.overlord/api.json').token")
curl -s -X POST http://127.0.0.1:7790/v1/agents_list -H "Authorization: Bearer $T" -d '{}'
curl -s -X POST http://127.0.0.1:7790/v1/agent_ask  -H "Authorization: Bearer $T" \
     -d '{"agentId":3,"text":"Which tests cover the login flow?","timeoutSec":300}'
```

| Tool | Arguments | Returns |
|---|---|---|
| `overlord_capabilities` | | Everything this Overlord supports (see [Discovering capabilities](#discovering-capabilities)) |
| `overlord_info` | | version, apiVersion, agent and peer counts |
| `agents_list` | `includeArchived?` | `{ agents: [{ id, name, title, cwd, status, pending, archived, sleeping, crashed, createdAt, sessionId, model }] }` |
| `agent_get` | `agentId` | The `agents_list` fields plus `lastPrompt`, `lastReply`, `spinner`, open `tools`, the open `question` input and `stats` |
| `agent_create` | `cwd`, `prompt?` | `{ agentId }` |
| `agent_send` | `agentId`, `text` | `{ queued: true }`. The message waits until the agent is at its prompt. If it can't be delivered, an `agent.send_failed` event follows. |
| `agent_ask` | `agentId`, `text`, `timeoutSec?` (default 600, max 3600) | `{ reply, done, status }`. If the agent stops for you, `done` is false and `pending` says why (`permission` or `question`). `timedOut` or `error` appear when those happen. |
| `agent_transcript` | `agentId`, `limit?` (default 100) | `{ events, total }`: the chat view's events (`prompt`, `text`, `tool`, `turn`, …) |
| `agent_screen` | `agentId`, `chars?` | `{ text }`: the end of the terminal output, with escape codes removed |
| `permission_answer` | `agentId`, `decision` (`allow`, `allow_always` or `deny`) or `option` (1–9) | `{ sent: true }`. 409 if the agent isn't waiting on a permission. |
| `question_answer` | `agentId`, `options` (one 1-based number per question) or `text` | `{ sent: true }`. 409 if the agent isn't waiting on a question. |
| `agent_keys` | `agentId`, `keys` | Sends raw keys to the terminal (`"\r"` Enter, `"\u001b"` Esc, `"\u001b[B"` down arrow) |
| `agent_interrupt` | `agentId` | Esc: stops the turn and drops queued sends |
| `agent_archive`, `agent_unarchive`, `agent_close` | `agentId` | `{ ok: true }` |
| `agent_wake` | `agentId` | `{ woke }`: resumes an agent CPU saving put to sleep (`woke` false if it wasn't asleep). You rarely need it: `agent_send` and `agent_ask` wake it themselves. |
| `chat_list` | | `{ peersEnabled, me, online, conversations }` |
| `chat_read` | `peer` or `group`, `limit?` | `{ messages }` |
| `chat_send` | `peer` or `group`, `text` | `{ conversation, message, offline }`. 409 if no recipient is online. |
| `events_poll` | `since?`, `types?`, `timeoutSec?` (max 60) | `{ events, seq }`. Long-poll: returns as soon as one event matches. |
| `webhook_add` | `url`, `types?` | `{ id, secret }`. The secret is shown only this once. |
| `webhook_list` | | `{ webhooks }` (without secrets) |
| `webhook_remove` | `id` | `{ ok: true }` |

What each field means:

- `status` is `active` (working) or `waiting` (idle at its prompt).
- `pending` is `permission`, `question` or `null`: whatever the agent is waiting for you to answer.
- `sleeping` is true while CPU saving has its CLI closed (Settings → CPU saving: an idle agent nobody has open). Its `status` stays `waiting`. Anything you send it resumes the same session first, which takes a few seconds; `agent_screen` shows the screen from before it slept until then.
- A multi-question `AskUserQuestion` may end on a review screen that needs Enter. Send it with `agent_keys` and `"\r"`. `agent_screen` shows you what the agent's screen shows.

## Events

| Event | Fields |
|---|---|
| `agent.created` | agentId, cwd, name, sessionId |
| `agent.closed`, `agent.archived`, `agent.unarchived`, `agent.crashed` | agentId |
| `agent.status` | agentId, status (`active` or `waiting`) |
| `agent.sleeping` | agentId, sleeping: CPU saving closed its CLI (`true`), or it was resumed (`false`) |
| `agent.pending` | agentId, kind (`permission` or `question`): the agent now waits on you |
| `agent.pending_cleared` | agentId |
| `agent.question` | agentId, input (the full `AskUserQuestion` input: questions, options, previews) |
| `agent.prompt` | agentId, text: a prompt reached its transcript |
| `agent.message` | agentId, text: an assistant message |
| `agent.title` | agentId, title |
| `agent.tool_start` / `agent.tool_done` | agentId, toolId, tool, status |
| `agent.send_failed` | agentId, text |
| `chat.message` | conversation (`{type:'peer'\|'group', id}`), group, message: sent or received peer chat |

Every event also carries `seq` (it increases by one per event and restarts at 1 when Overlord restarts) and `at` (ISO time).

To filter events, pass exact types or prefixes ending in `.`, comma-separated: `types=agent.status,chat.`

### SSE

```js
// Node 20+: read events as they happen.
const { token, eventsUrl } = require(require('os').homedir() + '/.overlord/api.json');
const res = await fetch(eventsUrl + '?types=agent.pending,agent.status', { headers: { authorization: 'Bearer ' + token } });
for await (const chunk of res.body) process.stdout.write(Buffer.from(chunk).toString());
```

To resume after a disconnect, send `Last-Event-ID: <seq>` or add `?since=<seq>`. Overlord replays what it still holds (the last 1000 events). A `seq` higher than the current one means Overlord restarted, and you get the whole buffer.

### Webhooks

`webhook_add` registers a URL on this machine: `http://127.0.0.1`, `localhost` or `[::1]`, any port. Overlord POSTs each matching event to it as JSON, one at a time and in order.

Each request has these headers:
- `X-Overlord-Event: <type>`
- `X-Overlord-Signature: sha256=<hex HMAC-SHA256 of the raw body, keyed with the secret>`

Answer with any 2xx. Overlord retries failures after 1 s, 5 s and 25 s, then drops that event. `webhook_list` shows `failures` (consecutive failed events). Webhooks persist across restarts.

## MCP

`POST /mcp` is a stateless MCP server (Streamable HTTP, with JSON responses). It offers the same tools. For example, in a Claude Code `.mcp.json`:

```json
{ "mcpServers": { "overlord": { "type": "http", "url": "http://127.0.0.1:7790/mcp",
  "headers": { "Authorization": "Bearer <token from api.json>" } } } }
```

MCP clients can't hold the SSE stream, so they get events with `events_poll`.
