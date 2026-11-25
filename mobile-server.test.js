const test = require('node:test');
const assert = require('node:assert');
const { createApi, TOOLS } = require('./api-core');
const { createMobileServer, lanAddresses, pairUrl, qrSvg, MOBILE_TOOLS } = require('./mobile-server');

const TOKEN = 'phone-token';
const host = {
  info: () => ({ version: '1.0.0' }), getAgentRaw: () => null,
  listAgents: () => [{ id: 1, name: 'Ada' }], getAgent: (id) => (id === 1 ? { id: 1 } : null),
  close: () => { throw new Error('must not be reachable'); },
  loadWebhooks: () => [], saveWebhooks: () => {}, fetch: async () => ({ status: 200 }), log: () => {},
};

async function withServer(fn, opts = {}) {
  const api = createApi(host);
  const srv = createMobileServer({ api, getToken: () => TOKEN, ...opts });
  const port = await srv.start();
  try { await fn({ api, port, srv }); } finally { await srv.stop(); }
}
const req = (port, path, { method = 'GET', body, token = TOKEN } = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, { method, body: body && JSON.stringify(body), headers: token ? { authorization: `Bearer ${token}` } : {} });

test('the page and health are open; the API needs the pairing token', () => withServer(async ({ port }) => {
  const page = await req(port, '/', { token: null });
  assert.strictEqual(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.strictEqual(page.headers.get('referrer-policy'), 'no-referrer');
  assert.match(await page.text(), /<title>Overlord<\/title>/);
  assert.strictEqual((await req(port, '/m/health', { token: null })).status, 200);
  assert.strictEqual((await req(port, '/m/agents_list', { method: 'POST', token: null })).status, 401);
  assert.strictEqual((await req(port, '/m/agents_list', { method: 'POST', token: 'wrong' })).status, 401);
}));

test('only the phone tools are reachable', () => withServer(async ({ port }) => {
  const r = await req(port, '/m/agents_list', { method: 'POST', body: {} });
  assert.deepStrictEqual(await r.json(), { agents: [{ id: 1, name: 'Ada' }] });
  for (const t of ['agent_close', 'agent_create', 'webhook_add', 'account_switch', 'pr_merge', 'agent_keys']) {
    assert.strictEqual((await req(port, `/m/${t}`, { method: 'POST', body: { agentId: 1 } })).status, 404, t);
  }
  assert.strictEqual((await req(port, '/m/agents_list')).status, 405);
  assert.strictEqual((await req(port, '/m/agent_get', { method: 'POST', body: { agentId: 9 } })).status, 404);
}));

test('every phone tool is a real API tool', () => {
  const names = new Set(TOOLS.map(t => t.name));
  for (const t of MOBILE_TOOLS) assert.ok(names.has(t), t);
});

test('wrong tokens lock an address out for a minute', async () => {
  let t = 0;
  await withServer(async ({ port }) => {
    for (let i = 0; i < 10; i++) await req(port, '/m/agents_list', { method: 'POST', token: 'nope' });
    assert.strictEqual((await req(port, '/m/agents_list', { method: 'POST', body: {} })).status, 429);
    t += 61000;
    assert.strictEqual((await req(port, '/m/agents_list', { method: 'POST', body: {} })).status, 200);
  }, { now: () => t });
});

test('events: only agent and chat events, resumable', () => withServer(async ({ api, port }) => {
  api.publish({ type: 'status', id: 1, status: 'active' });
  api.publish({ type: 'releasePause', pause: null });
  const ac = new AbortController();
  const r = await fetch(`http://127.0.0.1:${port}/m/events?since=0`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: ac.signal });
  assert.strictEqual(r.status, 200);
  const reader = r.body.getReader(); let text = '';
  while (!text.includes('agent.status')) text += new TextDecoder().decode((await reader.read()).value);
  ac.abort();
  assert.ok(!text.includes('release.paused'));
}));

test('lanAddresses ranks Tailscale, then LAN, and skips loopback, link-local and virtual adapters last', () => {
  const nets = {
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    'vEthernet (WSL)': [{ family: 'IPv4', address: '172.20.0.1', internal: false }],
    'Wi-Fi': [{ family: 'IPv4', address: '192.168.1.20', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }],
    Tailscale: [{ family: 'IPv4', address: '100.101.2.3', internal: false }],
    eth9: [{ family: 'IPv4', address: '169.254.1.1', internal: false }],
  };
  assert.deepStrictEqual(lanAddresses(nets).map(x => x.address), ['100.101.2.3', '192.168.1.20', '172.20.0.1']);
  assert.strictEqual(lanAddresses(nets)[0].kind, 'tailscale');
});

test('pairing URL keeps the token in the fragment; the QR is an SVG', () => {
  assert.strictEqual(pairUrl('192.168.1.20', 7791, 'a/b'), 'http://192.168.1.20:7791/#k=a%2Fb');
  assert.match(qrSvg('http://192.168.1.20:7791/#k=x'), /^<svg[^>]+viewBox="0 0 \d+ \d+"/);
});
