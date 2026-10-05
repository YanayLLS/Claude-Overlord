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
