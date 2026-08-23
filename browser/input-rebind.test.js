const test = require('node:test');
const assert = require('node:assert');
const { createInputRebinder, REBIND_TIMEOUT_MS } = require('./input-rebind');

// A webContents whose reload() completes on the next tick, like the real one.
function fakeWc({ finishes = true } = {}) {
  const handlers = {};
  return {
    reloads: 0,
    once(evt, fn) { handlers[evt] = fn; },
    reload() {
      this.reloads += 1;
      if (finishes) setTimeout(() => handlers['did-finish-load'] && handlers['did-finish-load'](), 0);
    },
  };
}

test('the first navigation triggers exactly one re-bind load', async () => {
  const w = fakeWc();
  const r = createInputRebinder();
  await r.rebind(w);
  assert.strictEqual(w.reloads, 1);
});

// The cost must land once per view, not on every navigation the agent makes.
test('later navigations do not reload again', async () => {
  const w = fakeWc();
  const r = createInputRebinder();
  await r.rebind(w);
  await r.rebind(w);
  await r.rebind(w);
  assert.strictEqual(w.reloads, 1);
});

test('the gate is open during the re-bind and closed before it resolves', async () => {
  const handlers = {};
  const w = { once: (e, fn) => { handlers[e] = fn; }, reload() {} };
  const r = createInputRebinder();
  assert.strictEqual(r.isSuppressed(), false);
  const pending = r.rebind(w);
  assert.strictEqual(r.isSuppressed(), true, 'suppressed while the internal load runs');
  handlers['did-finish-load']();
  await pending;
  assert.strictEqual(r.isSuppressed(), false, 'released once it is done');
});

test('a failed re-bind load still releases the gate', async () => {
  const handlers = {};
  const w = { once: (e, fn) => { handlers[e] = fn; }, reload() {} };
  const r = createInputRebinder();
  const pending = r.rebind(w);
  handlers['did-fail-load']();
  await pending;
  assert.strictEqual(r.isSuppressed(), false);
});

// navigate() awaits this, so a re-bind that never completes must not leave the
// agent's browser_navigate call hanging.
test('a re-bind load that never completes is bounded by a timeout', async () => {
  const w = fakeWc({ finishes: false });
  const r = createInputRebinder({ timeoutMs: 30 });
  const t0 = Date.now();
  await r.rebind(w);
  assert.ok(Date.now() - t0 < 2000, 'must give up at the timeout');
  assert.strictEqual(r.isSuppressed(), false);
});

test('the default timeout is bounded to a few seconds', () => {
  assert.ok(REBIND_TIMEOUT_MS > 0 && REBIND_TIMEOUT_MS <= 10000);
});

test('a webContents that cannot reload is left alone rather than throwing', async () => {
  const r = createInputRebinder();
  await assert.doesNotReject(() => r.rebind(null));
  await assert.doesNotReject(() => r.rebind({}));
  assert.strictEqual(r.isSuppressed(), false);
});
