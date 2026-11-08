// Local API: other programs on this machine drive Overlord. One tool list served three ways (api-server.js):
// REST (POST /v1/<tool>), MCP (POST /mcp) and events (GET /v1/events as SSE, or webhooks). Nothing here touches
// Electron: main.js hands in `host`, the few functions that reach agents and peer chat, and feeds every renderer
// message to publish(). Self-check: api-core.test.js

const crypto = require('crypto');

const API_VERSION = 1;
const RING_MAX = 1000;            // events kept for SSE resume (Last-Event-ID) and events_poll
const WEBHOOK_MAX = 20;
const WEBHOOK_RETRIES = [1000, 5000, 25000];
const WEBHOOK_QUEUE_MAX = 200;    // ponytail: a dead receiver drops its oldest undelivered events past this
const ASK_TIMEOUT_MAX_S = 3600;
const MCP_PROTOCOL = '2025-06-18';

// ── Auth ──────────────────────────────────────────────
const newToken = () => crypto.randomBytes(32).toString('base64url');
function tokenOk(header, token) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(header || ''));
  if (!m || !token) return false;
  const a = Buffer.from(m[1]), b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// DNS rebinding: a page on evil.com that resolves to 127.0.0.1 still sends Host: evil.com.
const hostOk = (host, port) => new RegExp(`^(127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}$`, 'i').test(String(host || ''));

// Webhooks only go to this machine: the API is for local programs, and a token holder must not turn agent
// transcripts into an outbound feed.
function webhookUrlOk(u) {
  let x; try { x = new URL(u); } catch { return false; }
  return x.protocol === 'http:' && /^(127\.0\.0\.1|localhost|\[::1\])$/i.test(x.hostname) && !x.username && !x.password;
}
const sign = (secret, body) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

// ── Events: renderer message → public event ──────────
// The renderer protocol is internal and chatty (termData is every byte of every terminal); this is the stable,
// documented subset. host gives the agent object for fields the raw message lacks. A new feature's state change gets
// a row here (CLAUDE.md, "Local API coverage"); overlord_capabilities lists this table as is.
// [renderer message type, public type, description, map]
const EVENTS = [
  ['agentCreated', 'agent.created', 'An agent started. Fields: agentId, cwd, name, sessionId.', (m) => ({ agentId: m.id, cwd: m.cwd, name: m.agentName, sessionId: m.sessionId })],
  ['agentClosed', 'agent.closed', 'An agent was closed for good. Fields: agentId.', (m) => ({ agentId: m.id })],
  ['agentArchived', 'agent.archived', 'An agent was archived. Fields: agentId.', (m) => ({ agentId: m.id })],
  ['agentUnarchived', 'agent.unarchived', 'An archived agent came back. Fields: agentId.', (m) => ({ agentId: m.id })],
  ['status', 'agent.status', 'An agent went active (working) or waiting (idle at its prompt). Fields: agentId, status.', (m) => ({ agentId: m.id, status: m.status })],
  ['perm', 'agent.pending', 'An agent now waits on you. Fields: agentId, kind (permission | question).', (m) => ({ agentId: m.id, kind: m.ask ? 'question' : 'permission' })],
  ['permClear', 'agent.pending_cleared', 'What the agent waited on was answered. Fields: agentId.', (m) => ({ agentId: m.id })],
  ['askInput', 'agent.question', 'The full input of a question an agent asks (questions, options, previews). Fields: agentId, input.', (m) => ({ agentId: m.id, input: m.input })],
  ['prompt', 'agent.prompt', 'A prompt reached an agent\'s transcript. Fields: agentId, text.', (m) => ({ agentId: m.id, text: m.text })],
  ['preview', 'agent.message', 'An agent wrote a message. Fields: agentId, text.', (m, a) => ({ agentId: m.id, text: (a && a.fullText) || m.text })],
  ['title', 'agent.title', 'An agent\'s title changed. Fields: agentId, title.', (m) => ({ agentId: m.id, title: m.text })],
  ['toolStart', 'agent.tool_start', 'An agent started a tool call. Fields: agentId, toolId, tool, status.', (m) => ({ agentId: m.id, toolId: m.toolId, tool: m.name, status: m.status })],
  ['toolDone', 'agent.tool_done', 'A tool call finished. Fields: agentId, toolId.', (m) => ({ agentId: m.id, toolId: m.toolId })],
  ['crashed', 'agent.crashed', 'An agent\'s CLI crashed. Fields: agentId.', (m) => ({ agentId: m.id })],
  ['sendFailed', 'agent.send_failed', 'A message for an agent could not be delivered. Fields: agentId, text.', (m) => ({ agentId: m.id, text: m.text })],
  ['chatMsg', 'chat.message', 'A peer-chat message was sent or received. Fields: conversation ({type: peer | group, id}), group, message.', (m) => ({ conversation: m.key, group: m.groupName, message: m.msg })],
];
const EVENT_BY_SOURCE = new Map(EVENTS.map(([src, type, , map]) => [src, { type, map }]));
const EVENT_TYPES = EVENTS.map(([, type, description]) => ({ type, description }));
function toEvent(msg, agentOf) {
  const e = msg && EVENT_BY_SOURCE.get(msg.type);
  return e ? { type: e.type, ...e.map(msg, msg.id !== undefined && agentOf ? agentOf(msg.id) : null) } : null;
}
// "agent." matches every agent event, "agent.status" just that one; none = everything.
const wants = (filter, type) => !filter || !filter.length || filter.some(f => f === type || (f.endsWith('.') && type.startsWith(f)));
const parseFilter = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map(s => String(s).trim()).filter(Boolean);

// ── Tools ─────────────────────────────────────────────
const S = (description, extra) => ({ type: 'string', description, ...extra });
const N = (description, extra) => ({ type: 'number', description, ...extra });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const AGENT = { agentId: N('Agent id, from agents_list.') };
const TO = { peer: S('Peer Overlord name, for a direct message.'), group: S('Group id, for a group conversation.') };

const TOOLS = [
  ['overlord_capabilities', 'What this Overlord can do: every tool with its input schema, every event type, how to connect (REST, MCP, SSE, webhooks), limits, and which optional features are switched on. Call it first when integrating.', obj({})],
  ['overlord_info','Overlord version, API version, and counts of agents and connected peers.', obj({})],
  ['agents_list', 'Every agent: id, name, title, folder, status (active | waiting), what it is pending on (permission | question | null), archived.', obj({ includeArchived: { type: 'boolean', description: 'Also list archived agents. Default false.' } })],
  ['agent_get', 'One agent in full: the agents_list fields plus its last prompt, last reply, open tools and an open question\'s input.', obj(AGENT, ['agentId'])],
  ['agent_create', 'Start a new agent in a folder, optionally with a first prompt. Returns its id.', obj({ cwd: S('Absolute folder path the agent works in.'), prompt: S('First prompt, submitted once the agent is ready.') }, ['cwd'])],
  ['agent_send', 'Send an agent a message (a prompt), as typing it in its chat. Queued until the agent is at its prompt; returns at once. Failure arrives as an agent.send_failed event.', obj({ ...AGENT, text: S('The message.') }, ['agentId', 'text'])],
  ['agent_ask', 'Ask an agent something and wait for its answer: sends the message, waits for the turn to end, returns the reply. Returns early with pending set when the agent stops to ask for a permission or answer.', obj({ ...AGENT, text: S('The question or task.'), timeoutSec: N('Give up after this long. Default 600, max 3600.') }, ['agentId', 'text'])],
  ['agent_transcript', 'An agent\'s conversation as structured events (prompt, text, tool, turn, ...), oldest first.', obj({ ...AGENT, limit: N('Last N events. Default 100, max 2000.') }, ['agentId'])],
  ['agent_screen', 'The raw tail of an agent\'s terminal output with escape codes removed: what its dialog shows when it waits on you.', obj({ ...AGENT, chars: N('How much of the tail. Default 4000, max 50000.') }, ['agentId'])],
  ['permission_answer', 'Answer the permission prompt an agent waits on. allow = Yes, allow_always = Yes and don\'t ask again, deny = No (Esc). option picks a menu number directly instead.', obj({ ...AGENT, decision: S('allow | allow_always | deny', { enum: ['allow', 'allow_always', 'deny'] }), option: N('1-based menu number, instead of decision.') }, ['agentId'])],
  ['question_answer', 'Answer the question an agent waits on (AskUserQuestion / plan approval). options: one 1-based choice per question, in order. text: a typed answer instead.', obj({ ...AGENT, options: { type: 'array', items: { type: 'number' }, description: 'One 1-based option number per question.' }, text: S('Free-text answer, typed into the question.') }, ['agentId'])],
  ['agent_keys', 'Raw keystrokes into an agent\'s terminal (e.g. "\\u001b[B" down arrow, "\\r" Enter, "\\u001b" Esc). For dialogs the other tools don\'t cover.', obj({ ...AGENT, keys: S('Characters to type, escape sequences included.') }, ['agentId', 'keys'])],
  ['agent_interrupt', 'Esc: stop what the agent is doing and drop messages still queued for it.', obj(AGENT, ['agentId'])],
  ['agent_archive', 'Archive an agent: its process stops, its chat is kept.', obj(AGENT, ['agentId'])],
  ['agent_unarchive', 'Bring an archived agent back.', obj(AGENT, ['agentId'])],
  ['agent_close', 'Close an agent for good (its transcript file stays on disk).', obj(AGENT, ['agentId'])],
  ['chat_list', 'Peer chat (people on other Overlords): the conversations, each with its last message, and which peers are online.', obj({})],
  ['chat_read', 'Messages of one peer-chat conversation, oldest first.', obj({ ...TO, limit: N('Last N messages. Default 50.') })],
  ['chat_send', 'Send a peer-chat message to a peer or group.', obj({ ...TO, text: S('The message.') }, ['text'])],
  ['events_poll', 'Events after a sequence number, waiting up to timeoutSec for one to arrive. For clients that can\'t hold an SSE stream (e.g. MCP).', obj({ since: N('Last seq you saw; 0 for what is buffered.'), types: { type: 'array', items: { type: 'string' }, description: 'Event types, or prefixes ending in "." (e.g. "agent."). Default all.' }, timeoutSec: N('Default 25, max 60.') })],
  ['webhook_add', 'Register a URL on this machine (http://127.0.0.1 or localhost) that gets each event POSTed as JSON, signed with X-Overlord-Signature: sha256=HMAC(secret, body). Returns the secret once.', obj({ url: S('http://127.0.0.1:<port>/<path>'), types: { type: 'array', items: { type: 'string' }, description: 'Event types or prefixes. Default all.' } }, ['url'])],
  ['webhook_list', 'Registered webhooks (no secrets), with delivery failure counts.', obj({})],
  ['webhook_remove', 'Remove a webhook.', obj({ id: S('Webhook id.') }, ['id'])],
].map(([name, description, inputSchema]) => ({ name, description, inputSchema }));

class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = (m) => new ApiError(400, m), missing = (m) => new ApiError(404, m), conflict = (m) => new ApiError(409, m);

// Arguments against the schema: required present, declared types, nothing unknown.
function checkArgs(tool, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw bad('arguments must be a JSON object');
  const { properties, required } = tool.inputSchema;
  for (const k of Object.keys(args)) if (!properties[k]) throw bad(`unknown argument: ${k}`);
  for (const k of required) if (args[k] === undefined || args[k] === null || args[k] === '') throw bad(`missing argument: ${k}`);
  for (const [k, v] of Object.entries(args)) {
    const p = properties[k], t = Array.isArray(v) ? 'array' : typeof v;
    if (t !== p.type) throw bad(`${k} must be a ${p.type}`);
    if (p.enum && !p.enum.includes(v)) throw bad(`${k} must be one of ${p.enum.join(', ')}`);
    if (t === 'array' && p.items && v.some(x => typeof x !== p.items.type)) throw bad(`${k} must hold ${p.items.type}s`);
  }
}
const clamp = (v, def, max) => Math.max(1, Math.min(max, Number.isFinite(v) ? Math.floor(v) : def));

// host: { info, features, getAgentRaw(id), listAgents(includeArchived), getAgent(id), createAgent(cwd, prompt), send(id, text, intoDialog),
//   keys(id, data), interrupt(id), archive(id), unarchive(id), close(id), transcript(id), screen(id),
//   chatList(), chatRead(to), chatSend(to, text), loadWebhooks(), saveWebhooks(list), fetch, log }
function createApi(host) {
  const ring = [];
  let seq = 0;
  const subs = new Set(); // fn(event) — SSE streams, pollers, asks
  let hooks = (host.loadWebhooks() || []).filter(h => h && h.id && webhookUrlOk(h.url)).map(h => ({ ...h, failures: h.failures || 0 }));
  const queues = new Map(); // hook id → { items: [], busy }

  function publish(msg) {
    let ev; try { ev = toEvent(msg, host.getAgentRaw); } catch { return null; }
    if (!ev) return null;
    ev = { seq: ++seq, at: new Date().toISOString(), ...ev };
    ring.push(ev); if (ring.length > RING_MAX) ring.shift();
    for (const fn of [...subs]) { try { fn(ev); } catch {} }
    for (const h of hooks) if (wants(h.types, ev.type)) enqueue(h, ev);
    return ev;
  }
  const subscribe = (fn) => { subs.add(fn); return () => subs.delete(fn); };
  // A seq past ours: the client saw a previous Overlord run (seq restarts at 1) — give it everything buffered.
  const since = (n, filter) => { if (n > seq) n = 0; return ring.filter(e => e.seq > n && wants(filter, e.type)); };

  // ── webhooks: one in flight per hook, in order, retried, then dropped ──
  function enqueue(h, ev) {
    const q = queues.get(h.id) || { items: [], busy: false };
    queues.set(h.id, q);
    q.items.push(ev); if (q.items.length > WEBHOOK_QUEUE_MAX) q.items.shift();
    if (!q.busy) drain(h, q);
  }
  async function drain(h, q) {
    q.busy = true;
    while (q.items.length && hooks.includes(h)) {
      const ev = q.items.shift(), body = JSON.stringify(ev);
      let ok = false;
      for (let i = 0; i <= WEBHOOK_RETRIES.length && !ok && hooks.includes(h); i++) {
        if (i) await new Promise(r => setTimeout(r, WEBHOOK_RETRIES[i - 1]));
        try {
          const r = await host.fetch(h.url, { method: 'POST', body, signal: AbortSignal.timeout(10000),
            headers: { 'content-type': 'application/json', 'x-overlord-event': ev.type, 'x-overlord-signature': sign(h.secret, body) } });
          ok = r.status >= 200 && r.status < 300;
        } catch {}
      }
      const before = h.failures;
      h.failures = ok ? 0 : h.failures + 1;
      if (!ok) host.log(`api webhook ${h.id} dropped ${ev.type} #${ev.seq} after ${WEBHOOK_RETRIES.length + 1} tries`);
      if ((before === 0) !== (h.failures === 0)) persistHooks();
    }
    q.busy = false;
  }
  const persistHooks = () => host.saveWebhooks(hooks.map(({ id, url, types, secret, failures, createdAt }) => ({ id, url, types, secret, failures, createdAt })));

  // ── agent_ask: send, then wait for the end of the turn that message started ──
  function ask(id, text, timeoutSec) {
    const a = host.getAgent(id); if (!a) throw missing(`no agent ${id}`);
    if (a.archived) throw conflict(`agent ${id} is archived`);
    if (a.pending) throw conflict(`agent ${id} waits on a ${a.pending}: answer it first (permission_answer / question_answer)`);
    const ms = clamp(timeoutSec, 600, ASK_TIMEOUT_MAX_S) * 1000;
    return new Promise((resolve) => {
      let started = false, timer;
      const done = (extra) => { clearTimeout(timer); off(); const now = host.getAgent(id) || {}; resolve({ agentId: id, reply: now.lastReply || '', status: now.status || 'closed', ...extra }); };
      // started: our prompt reached the transcript, or the agent went busy — a waiting status after that ends the turn.
      const off = subscribe((ev) => {
        if (ev.agentId !== id) return;
        if (ev.type === 'agent.prompt' || (ev.type === 'agent.status' && ev.status === 'active')) started = true;
        else if (ev.type === 'agent.status' && ev.status === 'waiting' && started) done({ done: true });
        else if (ev.type === 'agent.pending' && started) done({ done: false, pending: ev.kind });
        else if (ev.type === 'agent.closed') done({ done: false, error: 'agent closed' });
        else if (ev.type === 'agent.send_failed') done({ done: false, error: 'message not delivered: no CLI took it' });
      });
      timer = setTimeout(() => done({ done: false, timedOut: true }), ms);
      host.send(id, text, false);
    });
  }

  function needAgent(id) { const a = host.getAgent(id); if (!a) throw missing(`no agent ${id}`); return a; }
  function needPending(id, kind) {
    const a = needAgent(id);
    if (a.pending !== kind) throw conflict(`agent ${id} is not waiting on a ${kind}${a.pending ? ` (it waits on a ${a.pending})` : ''}`);
    return a;
  }
  const target = (args) => {
    if (!!args.peer === !!args.group) throw bad('give exactly one of peer or group');
    return args.peer ? { peer: args.peer } : { group: args.group };
  };
  const pause = (ms) => new Promise(r => setTimeout(r, ms));

  const HANDLERS = {
    // Built from the same tables call() and publish() use, so it can't list a tool or event that doesn't exist.
    overlord_capabilities: () => ({
      overlord: { version: String(host.info().version || '') },
      apiVersion: API_VERSION,
      auth: { scheme: 'Bearer', header: 'Authorization: Bearer <token>', tokenFile: '~/.overlord/api.json', note: 'Read port and token from the file on every connect; it exists only while the API runs.' },
      transports: {
        rest: { call: 'POST /v1/<tool> with the arguments as a JSON body', tools: 'GET /v1/tools', health: 'GET /v1/health (no token)', errors: { 400: 'bad arguments', 401: 'missing or wrong token', 404: 'no such agent, conversation or tool', 409: 'the agent is not in a state that allows it' } },
        mcp: { url: '/mcp', transport: 'Streamable HTTP, stateless, JSON responses', protocolVersion: MCP_PROTOCOL, events: 'events_poll' },
        sse: { url: '/v1/events', filter: '?types=<type or prefix.>,...', resume: 'Last-Event-ID header or ?since=<seq>', buffered: RING_MAX },
        webhooks: { add: 'webhook_add', urls: 'http://127.0.0.1, localhost or [::1] only', signature: 'X-Overlord-Signature: sha256=<hex HMAC-SHA256(secret, raw body)>', eventHeader: 'X-Overlord-Event', retriesMs: WEBHOOK_RETRIES, max: WEBHOOK_MAX },
      },
      features: host.features(),
      limits: { askTimeoutMaxSec: ASK_TIMEOUT_MAX_S, eventsBuffered: RING_MAX, webhooks: WEBHOOK_MAX },
      tools: TOOLS,
      events: EVENT_TYPES,
    }),
    overlord_info: () => ({ ...host.info(), apiVersion: API_VERSION }),
    agents_list: (x) => ({ agents: host.listAgents(!!x.includeArchived) }),
    agent_get: (x) => needAgent(x.agentId),
    agent_create: (x) => ({ agentId: host.createAgent(x.cwd, x.prompt || '') }),
    agent_send: (x) => { const a = needAgent(x.agentId); if (a.archived) throw conflict(`agent ${x.agentId} is archived`); host.send(x.agentId, x.text, false); return { queued: true }; },
    agent_ask: (x) => ask(x.agentId, x.text, x.timeoutSec),
    agent_transcript: (x) => { needAgent(x.agentId); const ev = host.transcript(x.agentId) || []; return { events: ev.slice(-clamp(x.limit, 100, 2000)), total: ev.length }; },
    agent_screen: (x) => { needAgent(x.agentId); const t = host.screen(x.agentId) || ''; return { text: t.slice(-clamp(x.chars, 4000, 50000)) }; },
    permission_answer: (x) => {
      needPending(x.agentId, 'permission');
      if (x.option === undefined && !x.decision) throw bad('give decision or option');
      if (x.option !== undefined && !(Number.isInteger(x.option) && x.option >= 1 && x.option <= 9)) throw bad('option must be 1-9');
      host.keys(x.agentId, x.option !== undefined ? String(x.option) : { allow: '1', allow_always: '2', deny: '\x1b' }[x.decision]);
      return { sent: true };
    },
    question_answer: async (x) => {
      needPending(x.agentId, 'question');
      if (!!x.options === (x.text !== undefined)) throw bad('give exactly one of options or text');
      if (x.text !== undefined) { host.send(x.agentId, x.text, true); return { sent: true }; }
      if (!x.options.length || x.options.some(n => !(Number.isInteger(n) && n >= 1 && n <= 9))) throw bad('options must be numbers 1-9');
      // One number per question: the CLI moves to the next question after each. A screen with a submit tab waits for Enter.
      for (const [i, n] of x.options.entries()) { if (i) await pause(400); host.keys(x.agentId, String(n)); }
      return { sent: true };
    },
    agent_keys: (x) => { needAgent(x.agentId); host.keys(x.agentId, x.keys); return { sent: true }; },
    agent_interrupt: (x) => { needAgent(x.agentId); host.interrupt(x.agentId); return { sent: true }; },
    agent_archive: (x) => { needAgent(x.agentId); host.archive(x.agentId); return { ok: true }; },
    agent_unarchive: (x) => { needAgent(x.agentId); host.unarchive(x.agentId); return { ok: true }; },
    agent_close: (x) => { needAgent(x.agentId); host.close(x.agentId); return { ok: true }; },
    chat_list: () => host.chatList(),
    chat_read: (x) => { const m = host.chatRead(target(x)); if (!m) throw missing('no such conversation'); return { messages: m.slice(-clamp(x.limit, 50, 2000)) }; },
    chat_send: (x) => { const r = host.chatSend(target(x), x.text); if (r.error) throw conflict(r.error); return r; },
    events_poll: (x) => new Promise((resolve) => {
      const filter = parseFilter(x.types);
      let from = Number.isFinite(x.since) ? x.since : 0; if (from > seq) from = 0;
      const now = since(from, filter);
      if (now.length) return resolve({ events: now, seq });
      const timer = setTimeout(() => { off(); resolve({ events: [], seq }); }, clamp(x.timeoutSec, 25, 60) * 1000);
      const off = subscribe((ev) => { if (ev.seq > from && wants(filter, ev.type)) { clearTimeout(timer); off(); resolve({ events: [ev], seq }); } });
    }),
    webhook_add: (x) => {
      if (!webhookUrlOk(x.url)) throw bad('url must be http://127.0.0.1, localhost or [::1] (this machine only)');
      if (hooks.length >= WEBHOOK_MAX) throw conflict(`at most ${WEBHOOK_MAX} webhooks`);
      const h = { id: crypto.randomUUID(), url: x.url, types: parseFilter(x.types), secret: newToken(), failures: 0, createdAt: new Date().toISOString() };
      hooks.push(h); persistHooks();
      return { id: h.id, url: h.url, types: h.types, secret: h.secret };
    },
    webhook_list: () => ({ webhooks: hooks.map(({ secret, ...h }) => h) }),
    webhook_remove: (x) => { const n = hooks.length; hooks = hooks.filter(h => h.id !== x.id); if (hooks.length === n) throw missing('no such webhook'); queues.delete(x.id); persistHooks(); return { ok: true }; },
  };

  async function call(name, args = {}) {
    const tool = TOOLS.find(t => t.name === name);
    if (!tool) throw missing(`no tool ${name}`);
    checkArgs(tool, args);
    return HANDLERS[name](args);
  }

  // MCP JSON-RPC (stateless Streamable HTTP, one JSON response per POST — as mcp/server.js).
  async function mcp(msg) {
    const { id, method, params } = msg || {};
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    if (method === 'initialize') return ok({ protocolVersion: MCP_PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'overlord', version: String(host.info().version || '') } });
    if (method === 'ping') return ok({});
    if (method === 'tools/list') return ok({ tools: TOOLS });
    if (method === 'tools/call') {
      try { const r = await call((params || {}).name, (params || {}).arguments || {}); return ok({ content: [{ type: 'text', text: JSON.stringify(r, null, 2) }], structuredContent: r }); }
      catch (e) { return ok({ content: [{ type: 'text', text: e.message || 'error' }], isError: true }); }
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }

  return { publish, subscribe, since, call, mcp, tools: TOOLS, seq: () => seq };
}

module.exports = { createApi, TOOLS, EVENT_TYPES, ApiError, toEvent, wants, parseFilter, tokenOk, hostOk, webhookUrlOk, sign, newToken, API_VERSION };
