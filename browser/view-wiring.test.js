const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { wireErrors } = require('./view-wiring');

function wired() {
  const wc = new EventEmitter(), loads = [], errors = [];
  wc.loadURL = (u) => { loads.push(u); return Promise.resolve(); };
  wireErrors(wc, { push: (e) => errors.push(e) });
  return { wc, loads, errors };
}

test('an https-only local dev server answering http empty is retried on https, with no error', async () => {
  const { wc, loads, errors } = wired();
  wc.emit('did-fail-load', {}, -324, 'ERR_EMPTY_RESPONSE', 'http://localhost:5173/', true);
  assert.deepStrictEqual(loads, [], 'not from inside the failing navigation event');
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(loads, ['https://localhost:5173/']);
  assert.strictEqual(errors.length, 0);
});

test('a failed https load, or a remote http one, is an error and not retried', () => {
  const { wc, loads, errors } = wired();
  wc.emit('did-fail-load', {}, -324, 'ERR_EMPTY_RESPONSE', 'https://localhost:5173/', true);
  wc.emit('did-fail-load', {}, -324, 'ERR_EMPTY_RESPONSE', 'http://example.com/', true);
  assert.deepStrictEqual(loads, []);
  assert.strictEqual(errors.length, 2);
});

test('network failures in the shared jar reach only the view that made the request', () => {
  const { onNetError } = require('./view-wiring');
  const a = [], b = [], routes = new Map([[1, { push: (e) => a.push(e) }], [2, { push: (e) => b.push(e) }]]);
  onNetError(routes, { webContentsId: 2, error: 'net::ERR_FAILED', url: 'https://x/api', resourceType: 'xhr' });
  onNetError(routes, { webContentsId: 1, error: 'net::ERR_ABORTED', url: 'https://x/', resourceType: 'xhr' });
  onNetError(routes, { webContentsId: 9, error: 'net::ERR_FAILED', url: 'https://x/', resourceType: 'xhr' });
  assert.strictEqual(a.length, 0);
  assert.strictEqual(b.length, 1);
});
