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

test('a page whose server is gone reports unreachable; other failures do not', () => {
  const wc = new EventEmitter(), gone = [];
  wc.loadURL = () => Promise.resolve();
  wireErrors(wc, { push() {} }, (u) => gone.push(u));
  wc.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://localhost:8765/', true);
  wc.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://nope.example/', true);
  wc.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://localhost:9/x.js', false); // a subframe
  wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'http://localhost:8765/', true);
  wc.emit('did-fail-load', {}, -501, 'ERR_INSECURE_RESPONSE', 'https://localhost:5173/', true);
  assert.deepStrictEqual(gone, ['http://localhost:8765/', 'https://nope.example/']);
});

test('localPort names the port of a page on this machine, null for a remote one', () => {
  const { localPort } = require('./view-wiring');
  assert.strictEqual(localPort('http://localhost:8765/'), 8765);
  assert.strictEqual(localPort('http://127.0.0.1:5173/x?y'), 5173);
  assert.strictEqual(localPort('https://app.lvh.me:5180'), 5180);
  assert.strictEqual(localPort('http://localhost/'), 80);
  assert.strictEqual(localPort('https://example.com:8765/'), null);
  assert.strictEqual(localPort('http://localhost.evil.com/'), null);
  assert.strictEqual(localPort(null), null);
});
