const test = require('node:test');
const assert = require('node:assert');
const { createGhCache, parseGet } = require('./gh-cache');

test('parseGet: plain GETs become URLs; writes, fields without -X GET, and unknown flags do not', () => {
  assert.strictEqual(parseGet(['api', 'repos/o/r/pulls/1']), 'https://api.github.com/repos/o/r/pulls/1');
  assert.strictEqual(parseGet(['api', '-X', 'GET', 'repos/o/r/actions/workflows/d.yml/runs', '-f', 'branch=dev', '-f', 'per_page=15']),
    'https://api.github.com/repos/o/r/actions/workflows/d.yml/runs?branch=dev&per_page=15');
  assert.strictEqual(parseGet(['api', 'repos/o/r/contents/a.json?ref=main']), 'https://api.github.com/repos/o/r/contents/a.json?ref=main');
  assert.strictEqual(parseGet(['api', 'repos/o/r/pulls', '-f', 'title=x']), null);
  assert.strictEqual(parseGet(['api', '-X', 'PUT', 'repos/o/r/contents/a']), null);
  assert.strictEqual(parseGet(['api', 'user', '--jq', '.login']), null);
  assert.strictEqual(parseGet(['api', '-X', 'GET', 'x', '-F', 'body=@file']), null);
  assert.strictEqual(parseGet(['pr', 'list']), null);
});

const res = (status, body, h = {}) => ({ status, headers: { get: k => h[k.toLowerCase()] ?? null }, json: async () => body });

test('second identical GET is answered from cache on 304; non-GET and errors go through gh', async () => {
  const sent = [], ran = [];
  const c = createGhCache({
    token: async () => 't',
    run: async (args) => { ran.push(args); return { data: 'gh' }; },
    fetch: async (url, o) => { sent.push(o.headers['If-None-Match'] || null); return url.endsWith('/404') ? res(404, {}) : o.headers['If-None-Match'] === '"e1"' ? res(304) : res(200, { n: 1 }, { etag: '"e1"' }); },
  });
  assert.deepStrictEqual(await c.ghJson(['api', 'repos/o/r']), { data: { n: 1 } });
  assert.deepStrictEqual(await c.ghJson(['api', 'repos/o/r']), { data: { n: 1 } });
  assert.deepStrictEqual(sent, [null, '"e1"']);
  assert.deepStrictEqual(await c.ghJson(['api', 'repos/o/r/404']), { data: 'gh' });
  assert.deepStrictEqual(await c.ghJson(['api', '-X', 'POST', 'repos/o/r/x']), { data: 'gh' });
  assert.strictEqual(ran.length, 2);
});

test('rate-limited answer pauses every call until the reset, without touching GitHub or gh', async () => {
  let t = 1000e3, calls = 0;
  const c = createGhCache({
    now: () => t, token: async () => 't',
    run: async () => { calls++; return { data: 'gh' }; },
    fetch: async () => { calls++; return res(403, {}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(2000) }); },
  });
  const r1 = await c.ghJson(['api', 'repos/o/r']);
  assert.strictEqual(r1.errorCode, 'ratelimit');
  assert.strictEqual(c.blockedUntil(), 2000e3);
  const r2 = await c.ghJson(['api', '-X', 'POST', 'repos/o/r/x']);
  assert.strictEqual(r2.errorCode, 'ratelimit');
  assert.strictEqual(calls, 1);
  t = 2001e3;
  assert.strictEqual(c.blockedUntil(), 0);
});
