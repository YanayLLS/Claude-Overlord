const test = require('node:test');
const assert = require('node:assert');
const { createPrWatch } = require('./pr-watch');

test('first answer only records the ETag; a new ETag fires onChange once; 304 and errors do not', async () => {
  const server = { 'a/x': 'e1', 'b/y': 'f1' };
  let fired = 0;
  const w = createPrWatch({
    get: async (repo, etag) => repo === 'bad/z' ? Promise.reject(new Error('net'))
      : etag === server[repo] ? { status: 304 } : { status: 200, etag: server[repo] },
    onChange: () => fired++,
  });
  await w.tick(['a/x', 'b/y', 'bad/z']);
  assert.strictEqual(fired, 0);
  await w.tick(['a/x', 'b/y', 'bad/z']);
  assert.strictEqual(fired, 0);
  server['a/x'] = 'e2'; server['b/y'] = 'f2';
  await w.tick(['a/x', 'b/y']);
  assert.strictEqual(fired, 1);
  await w.tick(['a/x', 'b/y']);
  assert.strictEqual(fired, 1);
});

test('a repo dropped from the list forgets its ETag, so re-adding it does not fire', async () => {
  let fired = 0, tag = 't1';
  const w = createPrWatch({ get: async () => ({ status: 200, etag: tag }), onChange: () => fired++ });
  await w.tick(['a/x']);
  await w.tick([]);
  tag = 't2';
  await w.tick(['a/x']);
  assert.strictEqual(fired, 0);
});

test('a key that keeps changing costs at most one paid answer per paidGapMs, however often it is ticked', async () => {
  let t = 0, paid = 0;
  const w = createPrWatch({
    now: () => t, paidGapMs: 60e3,
    get: async (key, etag) => { const cur = 'e' + Math.floor(t / 10e3); if (etag === cur) return { status: 304 }; paid++; return { status: 200, etag: cur }; },
    onChange: () => {},
  });
  for (t = 0; t < 3600e3; t += 10e3) await w.tick(['o/busy#runs']);
  assert.ok(paid <= 61, `paid ${paid} answers in an hour`);
});

test('a change is still noticed after the gap: onChange fires on the first tick past it', async () => {
  let t = 0, tag = 'a', fired = 0;
  const w = createPrWatch({ now: () => t, paidGapMs: 60e3, get: async (k, etag) => etag === tag ? { status: 304 } : { status: 200, etag: tag }, onChange: () => fired++ });
  await w.tick(['o/r']);
  tag = 'b'; t = 10e3; await w.tick(['o/r']);
  assert.strictEqual(fired, 0);
  t = 60e3; await w.tick(['o/r']);
  assert.strictEqual(fired, 1);
});
