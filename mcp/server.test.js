const test = require('node:test');
const assert = require('node:assert');
const { createMcpServer } = require('./server');

const ACTIONS = {
  navigate: async (url) => 'loaded ' + url,
  snapshot: async () => 'tree',
  screenshot: async () => 'QUJD',
  click: async () => 'ok',
  type: async () => 'ok',
  consoleErrors: async () => 'none',
  evaluate: async () => '1',
};

async function withServer(fn, resolveActions = () => ACTIONS) {
  const server = createMcpServer({ resolveActions });
  await server.start();
  try { await fn(server); } finally { await server.stop(); }
}

async function rpc(server, token, body) {
  const res = await fetch(`http://127.0.0.1:${server.port()}/mcp/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  return { status: res.status, json: raw ? JSON.parse(raw) : null };
}

test('listens on an OS-assigned port', async () => {
  await withServer((server) => { assert.ok(server.port() > 0); });
});

test('mintToken is idempotent per agent and unique across agents', async () => {
  await withServer((server) => {
    const a = server.mintToken(1);
    assert.strictEqual(server.mintToken(1), a);
    assert.notStrictEqual(server.mintToken(2), a);
  });
});

test('initialize returns protocol version and tools capability', async () => {
  await withServer(async (server) => {
    const token = server.mintToken(1);
    const { json } = await rpc(server, token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.strictEqual(json.id, 1);
    assert.ok(json.result.protocolVersion);
    assert.deepStrictEqual(json.result.capabilities.tools, {});
    assert.strictEqual(json.result.serverInfo.name, 'overlord-browser');
  });
});

test('tools/list returns the seven tools', async () => {
  await withServer(async (server) => {
    const token = server.mintToken(1);
    const { json } = await rpc(server, token, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.strictEqual(json.result.tools.length, 7);
  });
});

test('tools/call reaches the resolved actions for that token', async () => {
  await withServer(async (server) => {
    const token = server.mintToken(1);
    const { json } = await rpc(server, token, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'browser_navigate', arguments: { url: 'http://localhost:3000' } },
    });
    assert.strictEqual(json.result.content[0].text, 'loaded http://localhost:3000');
  });
});

test('each token resolves to its own agent', async () => {
  const seen = [];
  await withServer(async (server) => {
    const t2 = server.mintToken(2);
    await rpc(server, t2, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'browser_snapshot', arguments: {} } });
    assert.deepStrictEqual(seen, [2]);
  }, (agentId) => { seen.push(agentId); return ACTIONS; });
});

test('notifications get 202 with no body', async () => {
  await withServer(async (server) => {
    const token = server.mintToken(1);
    const { status, json } = await rpc(server, token, { jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.strictEqual(status, 202);
    assert.strictEqual(json, null);
  });
});

test('unknown method returns JSON-RPC -32601', async () => {
  await withServer(async (server) => {
    const token = server.mintToken(1);
    const { json } = await rpc(server, token, { jsonrpc: '2.0', id: 5, method: 'resources/list' });
    assert.strictEqual(json.error.code, -32601);
  });
});

test('unknown token is rejected with 404', async () => {
  await withServer(async (server) => {
    const { status } = await rpc(server, 'not-a-real-token', { jsonrpc: '2.0', id: 6, method: 'tools/list' });
    assert.strictEqual(status, 404);
  });
});

test('a revoked token stops working', async () => {
  await withServer(async (server) => {
    const token = server.mintToken(1);
    server.revokeToken(1);
    const { status } = await rpc(server, token, { jsonrpc: '2.0', id: 7, method: 'tools/list' });
    assert.strictEqual(status, 404);
  });
});

test('a token whose agent has no browser returns an error result', async () => {
  await withServer(async (server) => {
    const token = server.mintToken(1);
    const { json } = await rpc(server, token, { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'browser_snapshot', arguments: {} } });
    assert.strictEqual(json.result.isError, true);
    assert.match(json.result.content[0].text, /browser is unavailable/i);
  }, () => null);
});

test('GET on the endpoint is declined with 405', async () => {
  await withServer(async (server) => {
    const token = server.mintToken(1);
    const res = await fetch(`http://127.0.0.1:${server.port()}/mcp/${token}`);
    assert.strictEqual(res.status, 405);
  });
});

test('malformed JSON returns a parse error', async () => {
  await withServer(async (server) => {
    const token = server.mintToken(1);
    const res = await fetch(`http://127.0.0.1:${server.port()}/mcp/${token}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{ not json',
    });
    const json = await res.json();
    assert.strictEqual(json.error.code, -32700);
  });
});
