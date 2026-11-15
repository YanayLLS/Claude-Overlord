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

const res = (status, body, h = {}) => ({ status, headers: { get: k => h[k.toLowerCase()] ?? null }, json: async () => body, text: async () => JSON.stringify(body) });

test('second identical GET is answered from cache on 304; non-GET goes through gh; a 404 comes back as gh shapes it', async () => {
  const sent = [], ran = [];
  const c = createGhCache({
    token: async () => 't',
    run: async (args) => { ran.push(args); return { data: 'gh' }; },
    fetch: async (url, o) => { sent.push(o.headers['If-None-Match'] || null); return url.endsWith('/404') ? res(404, {}) : o.headers['If-None-Match'] === '"e1"' ? res(304) : res(200, { n: 1 }, { etag: '"e1"' }); },
  });
  assert.deepStrictEqual(await c.ghJson(['api', 'repos/o/r']), { data: { n: 1 } });
  assert.deepStrictEqual(await c.ghJson(['api', 'repos/o/r']), { data: { n: 1 } });
  assert.deepStrictEqual(sent, [null, '"e1"']);
  assert.deepStrictEqual(await c.ghJson(['api', 'repos/o/r/404']), { data: { status: '404' } });
  assert.deepStrictEqual(await c.ghJson(['api', '-X', 'POST', 'repos/o/r/x']), { data: 'gh' });
  assert.strictEqual(ran.length, 1);
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

test('cache evicts by body size: big bodies push the oldest out before the entry cap', async () => {
  const { createGhCache } = require('./gh-cache');
  const big = { pad: 'x'.repeat(11 * 1024 * 1024) }; // 11 MB each: the 3rd exceeds the 32 MB cap
  let n = 0;
  const gh = createGhCache({ run: async () => ({ data: 'gh' }), token: async () => 't', fetch: async (url, o) => (o.headers['If-None-Match'] ? res(304, null) : res(200, big, { etag: 'e' + (++n) })) });
  for (let i = 1; i <= 3; i++) await gh.ghJson(['api', '/r/' + i]);
  const before = n;
  await gh.ghJson(['api', '/r/1']); // evicted: a full 200 again, not a 304
  assert.strictEqual(n, before + 1);
  await gh.ghJson(['api', '/r/3']); // still cached: answered by 304
  assert.strictEqual(n, before + 1);
});

test('an answer GitHub already gave is not asked again through gh: a 404 costs one call, in gh\'s own shape', async () => {
  let runs = 0, fetches = 0;
  const c = createGhCache({ token: async () => 't', run: async () => { runs++; return { data: 'gh' }; },
    fetch: async () => { fetches++; return res(404, { message: 'Not Found' }); } });
  assert.deepStrictEqual(await c.ghJson(['api', 'repos/o/r/contents/holds.json']), { data: { message: 'Not Found', status: '404' } });
  assert.strictEqual(fetches + runs, 1);
});

test('a secondary-limit 403 (budget left, no Retry-After) pauses REST for a minute instead of re-sending through gh', async () => {
  let t = 1000e3, runs = 0, fetches = 0;
  const c = createGhCache({ now: () => t, token: async () => 't', run: async () => { runs++; return { data: 'gh' }; },
    fetch: async () => { fetches++; return res(403, { message: 'You have exceeded a secondary rate limit' }, { 'x-ratelimit-remaining': '4965' }); } });
  assert.strictEqual((await c.ghJson(['api', 'repos/o/r/actions/workflows/d.yml/runs'])).errorCode, 'ratelimit');
  assert.strictEqual((await c.ghJson(['api', 'repos/o/r/actions/workflows/d.yml/runs'])).errorCode, 'ratelimit');
  assert.strictEqual(c.blockedUntil(), 1060e3);
  assert.strictEqual(fetches + runs, 1);
});

test('the Releases deploy poll (38 run lists of ~220 KB) revalidates for free on its second pass', async () => {
  const body = { pad: 'x'.repeat(220 * 1024) };
  let paid = 0;
  const c = createGhCache({ token: async () => 't', run: async () => ({ data: 'gh' }),
    fetch: async (url, o) => o.headers['If-None-Match'] === 'e:' + url ? res(304) : (paid++, res(200, body, { etag: 'e:' + url })) });
  const pass = () => Promise.all(Array.from({ length: 38 }, (_, i) => c.ghJson(['api', '-X', 'GET', `repos/o/r/actions/workflows/d${i}.yml/runs`, '-f', 'per_page=15'])));
  await pass();
  paid = 0;
  await pass();
  assert.strictEqual(paid, 0);
});

test('a 401 drops the cached token and lets gh answer that call, as before', async () => {
  let dropped = 0, runs = 0;
  const c = createGhCache({ token: async () => 'old', onUnauthorized: () => dropped++, run: async () => { runs++; return { data: 'gh' }; },
    fetch: async () => res(401, { message: 'Bad credentials' }) });
  assert.deepStrictEqual(await c.ghJson(['api', 'repos/o/r']), { data: 'gh' });
  assert.strictEqual(dropped, 1);
  assert.strictEqual(runs, 1);
});

test('a cached answer comes back as a fresh object each time, so a caller editing it cannot change the next one', async () => {
  const c = createGhCache({ token: async () => 't', run: async () => ({ data: 'gh' }),
    fetch: async (url, o) => o.headers['If-None-Match'] ? res(304) : res(200, { n: 1 }, { etag: 'e' }) });
  (await c.ghJson(['api', 'repos/o/r'])).data.n = 99;
  assert.deepStrictEqual(await c.ghJson(['api', 'repos/o/r']), { data: { n: 1 } });
});

test('a poller passing paidGapMs pays at most one 200 per gap on a list that changes every poll', async () => {
  let t = 0, paid = 0;
  const c = createGhCache({ now: () => t, token: async () => 't', run: async () => ({ data: 'gh' }),
    fetch: async (url, o) => { const cur = 'e' + Math.floor(t / 10e3); if (o.headers['If-None-Match'] === cur) return res(304); paid++; return res(200, { at: t }, { etag: cur }); } });
  for (t = 0; t < 600e3; t += 10e3) await c.ghJson(['api', 'repos/o/r/actions/workflows/d.yml/runs'], undefined, { paidGapMs: 30e3 });
  assert.strictEqual(paid, 20);
  t = 600e3;
  assert.deepStrictEqual(await c.ghJson(['api', 'repos/o/r/actions/workflows/d.yml/runs']), { data: { at: 600e3 } }); // without the option: asks at once
});
