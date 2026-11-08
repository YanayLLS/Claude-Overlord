const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createApi } = require('./api-core');
const { createApiServer } = require('./api-server');

const TOKEN = 'secret-token';
const host = {
  info: () => ({ version: '1.0.0' }), getAgentRaw: () => null,
  listAgents: () => [{ id: 1, name: 'Ada' }], getAgent: (id) => (id === 1 ? { id: 1 } : null),
  loadWebhooks: () => [], saveWebhooks: () => {}, fetch: async () => ({ status: 200 }), log: () => {},
};

async function withServer(fn) {
  const api = createApi(host);
  const srv = createApiServer({ api, getToken: () => TOKEN });
  const port = await srv.start();
  try { await fn({ api, port }); } finally { await srv.stop(); }
}
const req = (port, path, { method = 'GET', body, token = TOKEN, headers = {} } = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, { method, body: body && JSON.stringify(body), headers: { ...(token && { authorization: `Bearer ${token}` }), ...headers } });

test('health is open; everything else needs the token', () => withServer(async ({ port }) => {
  assert.strictEqual((await req(port, '/v1/health', { token: null })).status, 200);
  assert.strictEqual((await req(port, '/v1/tools', { token: null })).status, 401);
  assert.strictEqual((await req(port, '/v1/agents_list', { method: 'POST', token: 'wrong' })).status, 401);
  assert.strictEqual((await req(port, '/mcp', { method: 'POST', token: null, body: { id: 1, method: 'ping' } })).status, 401);
}));

test('a foreign Host header is refused (DNS rebinding)', () => withServer(({ port }) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: '/v1/health', headers: { host: `evil.example:${port}` } }, (res) => {
    try { assert.strictEqual(res.statusCode, 403); resolve(); } catch (e) { reject(e); } res.resume();
  }).on('error', reject);
})));

test('REST: tool call, errors with their status', () => withServer(async ({ port }) => {
  const r = await req(port, '/v1/agents_list', { method: 'POST', body: {} });
  assert.deepStrictEqual(await r.json(), { agents: [{ id: 1, name: 'Ada' }] });
  assert.strictEqual((await req(port, '/v1/agent_get', { method: 'POST', body: { agentId: 5 } })).status, 404);
  assert.strictEqual((await req(port, '/v1/agent_get', { method: 'POST', body: {} })).status, 400);
  const nj = await fetch(`http://127.0.0.1:${port}/v1/agents_list`, { method: 'POST', body: '{', headers: { authorization: `Bearer ${TOKEN}` } });
  assert.strictEqual(nj.status, 400);
}));

test('MCP over HTTP', () => withServer(async ({ port }) => {
  const r = await (await req(port, '/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } })).json();
  assert.strictEqual(r.result.serverInfo.name, 'overlord');
  assert.strictEqual((await req(port, '/mcp', { method: 'POST', body: { jsonrpc: '2.0', method: 'notifications/initialized' } })).status, 202);
}));

test('SSE: replays from Last-Event-ID, then streams new events', () => withServer(async ({ api, port }) => {
  api.publish({ type: 'status', id: 1, status: 'active' });   // seq 1
  api.publish({ type: 'agentClosed', id: 2 });                // seq 2
  const res = await req(port, '/v1/events?types=agent.status', { headers: { 'last-event-id': '0' } });
  assert.strictEqual(res.status, 200);
  const reader = res.body.getReader(); let text = '';
  const until = async (re) => { while (!re.test(text)) { const { value, done } = await reader.read(); if (done) break; text += Buffer.from(value).toString(); } };
  await until(/id: 1\n/);
  api.publish({ type: 'status', id: 1, status: 'waiting' }); // seq 3
  await until(/id: 3\n/);
  assert.ok(!/id: 2\n/.test(text), 'filtered type not sent');
  assert.match(text, /event: agent\.status\ndata: \{"seq":3/);
  await reader.cancel();
}));
