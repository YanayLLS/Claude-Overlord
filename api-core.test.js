const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createApi, toEvent, wants, tokenOk, hostOk, webhookUrlOk, sign, TOOLS, EVENT_TYPES } = require('./api-core');

function fakeHost(over = {}) {
  const agents = new Map([[1, { id: 1, name: 'Ada', status: 'waiting', pending: null, archived: false, lastReply: '' }]]);
  const calls = [];
  let saved = [];
  const host = {
    agents, calls,
    info: () => ({ version: '9.9.9', agents: agents.size }),
    features: () => ({ peerChat: true }),
    getAgentRaw: (id) => (agents.has(id) ? { fullText: 'full ' + id } : null),
    listAgents: () => [...agents.values()],
    getAgent: (id) => agents.get(id) || null,
    createAgent: (cwd, prompt) => { calls.push(['create', cwd, prompt]); return 7; },
    send: (id, text, intoDialog) => calls.push(['send', id, text, intoDialog]),
    keys: (id, data) => calls.push(['keys', id, data]),
    interrupt: (id) => calls.push(['interrupt', id]),
    archive: () => {}, unarchive: () => {}, close: () => {},
    transcript: () => [{ type: 'prompt' }, { type: 'text' }, { type: 'turn' }],
    screen: () => 'abcdef',
    chatList: () => ({ conversations: [] }),
    chatRead: (to) => (to.peer === 'bob' ? [{ text: 'hi' }] : null),
    chatSend: (to, text) => (to.peer === 'bob' ? { id: 'm1', text } : { error: 'offline' }),
    loadWebhooks: () => saved, saveWebhooks: (l) => { saved = l; },
    fetch: async () => ({ status: 200 }), log: () => {},
    ...over,
  };
  return host;
}

test('auth helpers: bearer compare, loopback Host, webhook URL', () => {
  assert.ok(tokenOk('Bearer abc', 'abc'));
  assert.ok(!tokenOk('Bearer abd', 'abc'));
  assert.ok(!tokenOk('abc', 'abc'));
  assert.ok(!tokenOk('Bearer abc', ''));
  assert.ok(hostOk('127.0.0.1:7790', 7790) && hostOk('localhost:7790', 7790));
  assert.ok(!hostOk('evil.com:7790', 7790) && !hostOk('127.0.0.1:1', 7790) && !hostOk(undefined, 7790));
  assert.ok(webhookUrlOk('http://127.0.0.1:5000/hook') && webhookUrlOk('http://localhost/x'));
  assert.ok(!webhookUrlOk('https://example.com/x') && !webhookUrlOk('http://10.0.0.2/x') && !webhookUrlOk('http://u:p@localhost/x') && !webhookUrlOk('nope'));
  assert.match(sign('s', 'b'), /^sha256=[0-9a-f]{64}$/);
});

test('renderer messages map to public events; terminal bytes do not', () => {
  assert.deepStrictEqual(toEvent({ type: 'perm', id: 3, ask: true }), { type: 'agent.pending', agentId: 3, kind: 'question' });
  assert.deepStrictEqual(toEvent({ type: 'preview', id: 1, text: 'cut…' }, () => ({ fullText: 'whole' })).text, 'whole');
  assert.strictEqual(toEvent({ type: 'termData', id: 1, data: 'x' }), null);
  assert.ok(wants(['agent.'], 'agent.status') && wants(['agent.status'], 'agent.status') && wants([], 'chat.message'));
  assert.ok(!wants(['agent.status'], 'agent.pending') && !wants(['chat.'], 'agent.status'));
});

test('publish numbers events, keeps them for replay, filters by type', () => {
  const api = createApi(fakeHost());
  api.publish({ type: 'status', id: 1, status: 'active' });
  api.publish({ type: 'termData', id: 1, data: 'x' });
  api.publish({ type: 'chatMsg', key: { type: 'peer', id: 'bob' }, msg: { text: 'hi' } });
  assert.deepStrictEqual(api.since(0).map(e => e.seq), [1, 2]);
  assert.deepStrictEqual(api.since(0, ['chat.']).map(e => e.type), ['chat.message']);
  assert.deepStrictEqual(api.since(1).map(e => e.seq), [2]);
  assert.deepStrictEqual(api.since(999).map(e => e.seq), [1, 2]); // a client from a previous run
});

test('agent_ask refuses an agent that already waits on you', async () => {
  const h = fakeHost(), api = createApi(h);
  h.agents.get(1).pending = 'permission';
  await assert.rejects(api.call('agent_ask', { agentId: 1, text: 'hi' }), { status: 409, message: /answer it first/ });
  assert.strictEqual(h.calls.length, 0);
});

test('call validates arguments against the schema', async () => {
  const api = createApi(fakeHost());
  await assert.rejects(api.call('agent_get', {}), { status: 400, message: /missing argument: agentId/ });
  await assert.rejects(api.call('agent_get', { agentId: '1' }), { status: 400, message: /must be a number/ });
  await assert.rejects(api.call('agent_get', { agentId: 1, x: 1 }), { status: 400, message: /unknown argument/ });
  await assert.rejects(api.call('agent_get', { agentId: 9 }), { status: 404 });
  await assert.rejects(api.call('nope', {}), { status: 404 });
  await assert.rejects(api.call('permission_answer', { agentId: 1, decision: 'maybe' }), { status: 400, message: /one of/ });
  assert.strictEqual((await api.call('agent_get', { agentId: 1 })).name, 'Ada');
});

test('permission and question answers only go to an agent that waits on one', async () => {
  const h = fakeHost(), api = createApi(h);
  await assert.rejects(api.call('permission_answer', { agentId: 1, decision: 'allow' }), { status: 409 });
  h.agents.get(1).pending = 'permission';
  await api.call('permission_answer', { agentId: 1, decision: 'deny' });
  await api.call('permission_answer', { agentId: 1, option: 2 });
  await assert.rejects(api.call('question_answer', { agentId: 1, options: [1] }), { status: 409, message: /waits on a permission/ });
  h.agents.get(1).pending = 'question';
  await api.call('question_answer', { agentId: 1, options: [2, 1] });
  await api.call('question_answer', { agentId: 1, text: 'Postgres' });
  await assert.rejects(api.call('question_answer', { agentId: 1 }), { status: 400 });
  assert.deepStrictEqual(h.calls, [['keys', 1, '\x1b'], ['keys', 1, '2'], ['keys', 1, '2'], ['keys', 1, '1'], ['send', 1, 'Postgres', true]]);
});

test('agent_ask waits for the turn its message starts, then returns the reply', async () => {
  const h = fakeHost(), api = createApi(h);
  const p = api.call('agent_ask', { agentId: 1, text: 'what is 2+2?' });
  assert.deepStrictEqual(h.calls[0], ['send', 1, 'what is 2+2?', false]);
  api.publish({ type: 'status', id: 1, status: 'waiting' }); // an earlier turn ending: not ours yet
  api.publish({ type: 'prompt', id: 1, text: 'what is 2+2?' });
  h.agents.get(1).lastReply = '4';
  api.publish({ type: 'status', id: 1, status: 'waiting' });
  assert.deepStrictEqual(await p, { agentId: 1, reply: '4', status: 'waiting', done: true });
});

test('agent_ask returns early when the agent stops for a permission', async () => {
  const api = createApi(fakeHost());
  const p = api.call('agent_ask', { agentId: 1, text: 'run it' });
  api.publish({ type: 'status', id: 1, status: 'active' });
  api.publish({ type: 'perm', id: 1, ask: false });
  const r = await p;
  assert.strictEqual(r.done, false); assert.strictEqual(r.pending, 'permission');
});

test('events_poll returns buffered events at once, or the next one to arrive', async () => {
  const api = createApi(fakeHost());
  api.publish({ type: 'status', id: 1, status: 'active' });
  assert.strictEqual((await api.call('events_poll', { since: 0 })).events.length, 1);
  const p = api.call('events_poll', { since: 1, types: ['agent.closed'], timeoutSec: 5 });
  api.publish({ type: 'status', id: 1, status: 'waiting' });
  api.publish({ type: 'agentClosed', id: 1 });
  assert.deepStrictEqual((await p).events.map(e => e.type), ['agent.closed']);
});

test('webhooks: loopback only, signed delivery, persisted without leaking the secret in list', async () => {
  const got = [];
  const h = fakeHost({ fetch: async (url, o) => { got.push({ url, o }); return { status: 204 }; } });
  const api = createApi(h);
  await assert.rejects(api.call('webhook_add', { url: 'https://example.com/hook' }), { status: 400 });
  const w = await api.call('webhook_add', { url: 'http://127.0.0.1:5000/hook', types: ['agent.status'] });
  assert.ok(w.secret);
  assert.ok(!('secret' in (await api.call('webhook_list')).webhooks[0]));
  api.publish({ type: 'agentClosed', id: 1 }); // filtered out
  api.publish({ type: 'status', id: 1, status: 'active' });
  await new Promise(r => setImmediate(r));
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].o.headers['x-overlord-signature'], sign(w.secret, got[0].o.body));
  assert.strictEqual(JSON.parse(got[0].o.body).type, 'agent.status');
  assert.strictEqual(h.loadWebhooks().length, 1); // persisted: survives a restart
  await api.call('webhook_remove', { id: w.id });
  assert.strictEqual(h.loadWebhooks().length, 0);
});

test('peer chat: exactly one target, offline is a conflict', async () => {
  const api = createApi(fakeHost());
  await assert.rejects(api.call('chat_send', { text: 'x' }), { status: 400 });
  await assert.rejects(api.call('chat_send', { peer: 'bob', group: 'g', text: 'x' }), { status: 400 });
  await assert.rejects(api.call('chat_send', { peer: 'eve', text: 'x' }), { status: 409, message: 'offline' });
  assert.strictEqual((await api.call('chat_send', { peer: 'bob', text: 'yo' })).id, 'm1');
  assert.deepStrictEqual((await api.call('chat_read', { peer: 'bob' })).messages, [{ text: 'hi' }]);
});

test('overlord_capabilities lists every tool and event, with transports and feature switches', async () => {
  const c = await createApi(fakeHost()).call('overlord_capabilities');
  assert.deepStrictEqual(c.tools.map(t => t.name), TOOLS.map(t => t.name));
  assert.ok(c.events.some(e => e.type === 'agent.pending' && e.description));
  assert.deepStrictEqual(Object.keys(c.transports), ['rest', 'mcp', 'sse', 'webhooks']);
  assert.deepStrictEqual(c.features, { peerChat: true });
  assert.strictEqual(c.overlord.version, '9.9.9');
});

// CLAUDE.md "Local API coverage": a tool or event added in code but not in the integration guide fails here.
test('docs/local-api.md documents every tool and every event type', () => {
  const doc = fs.readFileSync(path.join(__dirname, 'docs', 'local-api.md'), 'utf8');
  const missing = [...TOOLS.map(t => t.name), ...EVENT_TYPES.map(e => e.type)].filter(n => !doc.includes('`' + n + '`'));
  assert.deepStrictEqual(missing, [], 'add these to docs/local-api.md');
});

test('MCP: tools/list and tools/call share the REST tools; errors come back as isError', async () => {
  const api = createApi(fakeHost());
  const list = await api.mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.ok(list.result.tools.some(t => t.name === 'agent_ask'));
  const ok = await api.mcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'agents_list', arguments: {} } });
  assert.strictEqual(ok.result.structuredContent.agents[0].name, 'Ada');
  const bad = await api.mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'agent_get', arguments: { agentId: 9 } } });
  assert.strictEqual(bad.result.isError, true);
  assert.strictEqual((await api.mcp({ jsonrpc: '2.0', id: 4, method: 'x' })).error.code, -32601);
});
