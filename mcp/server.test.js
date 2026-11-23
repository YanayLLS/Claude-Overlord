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

async function withServer(fn, resolveActions = () => ACTIONS, prClaims = null) {
  const server = createMcpServer({ resolveActions, prClaims });
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

test('tools/list returns the eight browser tools, three terminal tools, show_visual, the eight PR tools, close_self, the five release tools, the two agent-messaging tools and the two account tools', async () => {
  await withServer(async (server) => {
    const token = server.mintToken(1);
    const { json } = await rpc(server, token, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.strictEqual(json.result.tools.length, 32);
    assert.ok(['agent_list', 'agent_message', 'account_list', 'account_use', 'account_switch'].every(n => json.result.tools.some(t => t.name === n)));
    assert.ok(["release_status", "release_open", "release_sign", "release_all", "release_rerun_failed"].every(n => json.result.tools.some(t => t.name === n)));
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

test('terminal_* tools read the Terminals pane, for any agent token', async () => {
  const terminals = { list: () => 'FL Backend — running', read: (n, o) => `${n}:${o.lines}:${o.grep}`, restart: (n) => `Restarted "${n}".` };
  const server = createMcpServer({ resolveActions: () => null, getTerminals: () => terminals });
  await server.start();
  try {
    const token = server.mintToken(1);
    const call = (name, args) => rpc(server, token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } }).then(r => r.json.result);
    assert.strictEqual((await call('terminal_list', {})).content[0].text, 'FL Backend — running');
    assert.strictEqual((await call('terminal_read', { name: 'FL Backend', lines: 50, grep: 'err' })).content[0].text, 'FL Backend:50:err');
    assert.strictEqual((await call('terminal_read', {})).isError, true);
  } finally { await server.stop(); }
});

test('show_visual answers even when the agent has no browser', async () => {
  await withServer(async (server) => {
    const token = server.mintToken(1);
    const { json } = await rpc(server, token, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'show_visual', arguments: { html: '<b>hi</b>' } } });
    assert.strictEqual(json.result.content[0].text, 'Shown in the chat.');
  }, () => null);
});

test('initialize tells agents to show visuals in the chat', async () => {
  await withServer(async (server) => {
    const { json } = await rpc(server, server.mintToken(1), { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.match(json.result.instructions, /show_visual/);
  });
});

test("pr_claim and pr_release reach the claims host with the calling agent's id", async () => {
  const seen = [];
  const claims = { claim: (id, pr) => (seen.push(['claim', id, pr]), id === 1 ? { text: 'Claimed.' } : { error: '@Ada is already working on this PR.' }), release: (id, pr) => (seen.push(['release', id, pr]), { text: 'Released.' }) };
  await withServer(async (server) => {
    const t1 = server.mintToken(1), t2 = server.mintToken(2);
    const call = (t, name) => rpc(server, t, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: { pr: 'o/r#5' } } }).then((r) => r.json.result);
    assert.strictEqual((await call(t1, 'pr_claim')).content[0].text, 'Claimed.');
    const second = await call(t2, 'pr_claim');
    assert.strictEqual(second.isError, true);
    assert.match(second.content[0].text, /already working/);
    assert.strictEqual((await call(t1, 'pr_release')).content[0].text, 'Released.');
    assert.deepStrictEqual(seen, [['claim', 1, 'o/r#5'], ['claim', 2, 'o/r#5'], ['release', 1, 'o/r#5']]);
  }, () => ACTIONS, claims);
});

test('PR panel tools reach the PR host and turn { error } into isError', async () => {
  const seen = [];
  const claims = {
    list: (o) => (seen.push(['list', o]), { prs: [{ url: 'u1' }] }),
    autoMerge: async (prs, on) => (seen.push(['auto', prs, on]), { urls: prs }),
    merge: async (pr) => (seen.push(['merge', pr]), { error: 'Blocked: needs two signatures' }),
    approve: async (pr) => ({ approved: pr }), fix: async (pr) => ({ agentId: 9 }),
    hide: async (pr, how, undo, hours) => (seen.push(['hide', pr, how, undo, hours]), { url: pr, hidden: how }),
  };
  await withServer(async (server) => {
    const t = server.mintToken(1);
    const call = (name, args) => rpc(server, t, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } }).then((r) => r.json.result);
    const tools = (await rpc(server, t, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })).json.result.tools.map((x) => x.name);
    assert.ok(['pr_list', 'pr_auto_merge', 'pr_merge', 'pr_approve', 'pr_fix', 'pr_hide'].every((n) => tools.includes(n)));
    assert.deepStrictEqual(JSON.parse((await call('pr_list', { mine: true })).content[0].text), { prs: [{ url: 'u1' }] });
    await call('pr_auto_merge', { prs: ['o/r#1'] });
    const m = await call('pr_merge', { pr: 'o/r#2' });
    assert.strictEqual(m.isError, true); assert.match(m.content[0].text, /two signatures/);
    assert.strictEqual((await call('pr_approve', {})).isError, true); // pr required
    await call('pr_hide', { pr: 'o/r#3', how: 'snooze', hours: 2 });
    assert.deepStrictEqual(seen, [['list', { mine: true }], ['auto', ['o/r#1'], true], ['merge', 'o/r#2'], ['hide', 'o/r#3', 'snooze', false, 2]]);
  }, () => ACTIONS, claims);
});

test('agent_message hands the calling agent, the name and the text to the host; agent_list lists; errors come back as tool errors', async () => {
  const seen = [];
  const messaging = {
    list: (from) => [{ name: 'Ada', title: 't', cwd: 'C:/w', status: 'sleeping', from }],
    send: (from, name, text) => { if (name === 'Nobody') throw new Error('No agent named Nobody in this Overlord.'); seen.push([from, name, text]); return 'Sent.'; },
  };
  const server = createMcpServer({ resolveActions: () => ACTIONS, messaging });
  await server.start();
  try {
    const t = server.mintToken(4);
    const call = async (name, args) => (await rpc(server, t, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).json.result;
    const sent = await call('agent_message', { agent: '@Ada', text: 'hello' });
    assert.ok(!sent.isError); assert.strictEqual(sent.content[0].text, 'Sent.');
    assert.deepStrictEqual(seen, [[4, 'Ada', 'hello']]); // the @ is dropped, the caller is the token's agent
    assert.strictEqual((await call('agent_message', { agent: 'Nobody', text: 'x' })).isError, true);
    assert.strictEqual((await call('agent_message', { agent: 'Ada' })).isError, true); // text required
    assert.deepStrictEqual(JSON.parse((await call('agent_list', {})).content[0].text)[0].from, 4);
  } finally { await server.stop(); }
});

test("close_self is listed and asks the host to close the calling agent", async () => {
  const seen = [];
  const server = createMcpServer({ resolveActions: () => ACTIONS, closeSelf: (id) => (seen.push(id), true) });
  await server.start();
  try {
    const t = server.mintToken(4);
    const list = await rpc(server, t, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    assert.ok(list.json.result.tools.some((x) => x.name === 'close_self'));
    const r = (await rpc(server, t, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'close_self', arguments: {} } })).json.result;
    assert.ok(!r.isError);
    assert.deepStrictEqual(seen, [4]);
  } finally { await server.stop(); }
});

test('POST /hook/<token> hands the tool input to onEditHook for that agent and returns its answer', async () => {
  const seen = [];
  const server = createMcpServer({ resolveActions: () => ACTIONS, onEditHook: async (agentId, input) => { seen.push([agentId, input.file_path]); return { deny: 'use the worktree' }; } });
  await server.start();
  try {
    const token = server.mintToken(7);
    const res = await fetch(`http://127.0.0.1:${server.port()}/hook/${token}`, { method: 'POST', body: JSON.stringify({ tool_input: { file_path: 'C:/x.js' } }) });
    assert.deepStrictEqual(await res.json(), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'use the worktree' } });
    assert.deepStrictEqual(seen, [[7, 'C:/x.js']]);
    const bad = await fetch(`http://127.0.0.1:${server.port()}/hook/nope`, { method: 'POST', body: '{}' });
    assert.strictEqual(bad.status, 404);
  } finally { await server.stop(); }
});
