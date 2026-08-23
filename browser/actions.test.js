const test = require('node:test');
const assert = require('node:assert');
const { createActions, CAPTURE_TIMEOUT_MS } = require('./actions');
const { createErrorBuffer } = require('./errors');

function fakeWc(overrides = {}) {
  const sent = [];
  const wc = {
    sent,
    getURL: () => 'http://localhost:3000/final',
    loadURL: async () => {},
    executeJavaScript: async () => ({ title: 'T', url: 'u', tree: 'button "Go" [ref_1]', text: 'Hello world' }),
    capturePage: async () => ({ isEmpty: () => false, toPNG: () => Buffer.from('PNGDATA') }),
    sendInputEvent: (e) => sent.push(e),
    ...overrides,
  };
  return wc;
}

const build = (wc) => createActions({ getWebContents: () => wc, errors: createErrorBuffer(() => {}) });

test('navigate loads and returns the final URL', async () => {
  const loaded = [];
  const actions = build(fakeWc({ loadURL: async (u) => { loaded.push(u); } }));
  const out = await actions.navigate('http://localhost:3000');
  assert.deepStrictEqual(loaded, ['http://localhost:3000']);
  assert.match(out, /http:\/\/localhost:3000\/final/);
});

test('navigate rejects a non-http url before touching the page', async () => {
  const actions = build(fakeWc({ loadURL: async () => { throw new Error('should not be called'); } }));
  await assert.rejects(() => actions.navigate('file:///etc/passwd'), /http/);
});

// A view's first navigation leaves input routed at a discarded widget, so
// clicks are silently dropped. navigate() must not report success until the
// re-bind has run, or navigate -> snapshot -> click fails on the first page.
test('navigate awaits the input re-bind before reporting the page loaded', async () => {
  const order = [];
  const wc = fakeWc({ loadURL: async () => { order.push('load'); } });
  const actions = createActions({
    getWebContents: () => wc,
    errors: createErrorBuffer(() => {}),
    rebindInput: async (w) => { assert.strictEqual(w, wc); order.push('rebind'); },
  });
  order.push(await actions.navigate('http://localhost:3000') && 'returned');
  assert.deepStrictEqual(order, ['load', 'rebind', 'returned']);
});

test('a failed load never reaches the re-bind', async () => {
  let rebound = false;
  const wc = fakeWc({ loadURL: async () => { throw new Error('ERR_CONNECTION_REFUSED'); } });
  const actions = createActions({
    getWebContents: () => wc,
    errors: createErrorBuffer(() => {}),
    rebindInput: async () => { rebound = true; },
  });
  await assert.rejects(() => actions.navigate('http://localhost:1'));
  assert.strictEqual(rebound, false);
});

test('navigate surfaces a load failure as a thrown error', async () => {
  const actions = build(fakeWc({ loadURL: async () => { throw new Error('ERR_CONNECTION_REFUSED'); } }));
  await assert.rejects(() => actions.navigate('http://localhost:1'), /ERR_CONNECTION_REFUSED/);
});

test('snapshot returns the serialized tree with the page title', async () => {
  const out = await build(fakeWc()).snapshot();
  assert.match(out, /button "Go" \[ref_1\]/);
  assert.match(out, /T/);
});

test('snapshot includes the page visible text, not just its controls', async () => {
  const out = await build(fakeWc()).snapshot();
  assert.match(out, /visible text/);
  assert.match(out, /Hello world/);
});

test('snapshot omits the text section entirely when the page has none', async () => {
  const wc = fakeWc({ executeJavaScript: async () => ({ title: 'T', url: 'u', tree: 'x', text: '' }) });
  assert.doesNotMatch(await build(wc).snapshot(), /visible text/);
});

test('screenshot uses capturePage when it returns a real image', async () => {
  const out = await build(fakeWc()).screenshot();
  assert.strictEqual(out, Buffer.from('PNGDATA').toString('base64'));
});

// Regression, measured on real Electron 33: a hidden WebContentsView renders no
// frames. capturePage() rejects and CDP Page.captureScreenshot never resolves —
// so the old CDP fallback left the agent's tool call hanging forever. Every
// screenshot path must now settle, with an image or an explanation.
test('screenshot reports unavailability instead of hanging when capturePage rejects', async () => {
  const wc = fakeWc({ capturePage: async () => { throw new Error('Current display surface not available for capture'); } });
  await assert.rejects(() => build(wc).screenshot(), /Screenshot unavailable/i);
});

test('the unavailability message points the agent at browser_snapshot', async () => {
  const wc = fakeWc({ capturePage: async () => { throw new Error('nope'); } });
  await assert.rejects(() => build(wc).screenshot(), /browser_snapshot/);
});

test('screenshot preserves the underlying capture error for diagnosis', async () => {
  const wc = fakeWc({ capturePage: async () => { throw new Error('Current display surface not available'); } });
  await assert.rejects(() => build(wc).screenshot(), /Current display surface not available/);
});

test('an empty image is treated as a failure, not returned as a blank PNG', async () => {
  const wc = fakeWc({ capturePage: async () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }) });
  const actions = createActions({ getWebContents: () => wc, errors: createErrorBuffer(() => {}), captureTimeoutMs: 30 });
  await assert.rejects(() => actions.screenshot(), /Screenshot unavailable/i);
});

// A view that has just been shown in the pane composites its first frame a
// second or two later; until then capturePage resolves empty. Giving up on the
// first empty result would make pane screenshots fail at random.
test('screenshot retries an empty image until a frame arrives', async () => {
  let calls = 0;
  const wc = fakeWc({
    capturePage: async () => {
      calls += 1;
      return calls < 3
        ? { isEmpty: () => true, toPNG: () => Buffer.alloc(0) }
        : { isEmpty: () => false, toPNG: () => Buffer.from('LATE') };
    },
  });
  const actions = createActions({ getWebContents: () => wc, errors: createErrorBuffer(() => {}), captureTimeoutMs: 4000 });
  assert.strictEqual(await actions.screenshot(), Buffer.from('LATE').toString('base64'));
  assert.strictEqual(calls, 3);
});

// The hidden case must stay instant: it rejects and will never recover, so
// burning the whole timeout budget on retries would waste the agent's turn.
test('a rejecting capture is not retried — the hidden answer comes back at once', async () => {
  let calls = 0;
  const wc = fakeWc({ capturePage: async () => { calls += 1; throw new Error('Current display surface not available for capture'); } });
  const actions = createActions({ getWebContents: () => wc, errors: createErrorBuffer(() => {}), captureTimeoutMs: 4000 });
  await assert.rejects(() => actions.screenshot(), /Screenshot unavailable/i);
  assert.strictEqual(calls, 1);
});

test('screenshot settles rather than hanging when capturePage never resolves', async () => {
  const wc = fakeWc({ capturePage: () => new Promise(() => {}) });
  const actions = createActions({ getWebContents: () => wc, errors: createErrorBuffer(() => {}), captureTimeoutMs: 30 });
  const t0 = Date.now();
  await assert.rejects(() => actions.screenshot(), /timed out/i);
  assert.ok(Date.now() - t0 < 2000, 'must settle at the timeout, not later');
});

test('the capture timeout is bounded to a few seconds', () => {
  assert.ok(CAPTURE_TIMEOUT_MS > 0 && CAPTURE_TIMEOUT_MS <= 10000);
});

test('click dispatches mouseDown and mouseUp at the resolved point', async () => {
  const wc = fakeWc({ executeJavaScript: async () => ({ x: 40, y: 12 }) });
  await build(wc).click('ref_1');
  assert.deepStrictEqual(wc.sent.map((e) => e.type), ['mouseDown', 'mouseUp']);
  assert.strictEqual(wc.sent[0].x, 40);
  assert.strictEqual(wc.sent[0].y, 12);
});

test('click on a stale ref says so explicitly', async () => {
  const wc = fakeWc({ executeJavaScript: async () => null });
  await assert.rejects(() => build(wc).click('ref_9'), /stale.*browser_snapshot/i);
});

test('type on a stale ref says so explicitly', async () => {
  const wc = fakeWc({ executeJavaScript: async () => null });
  await assert.rejects(() => build(wc).type('ref_9', 'hi', false), /stale.*browser_snapshot/i);
});

test('type clicks the element then sends one char event per character', async () => {
  const wc = fakeWc({ executeJavaScript: async () => ({ x: 1, y: 1 }) });
  await build(wc).type('ref_1', 'hi', false);
  const chars = wc.sent.filter((e) => e.type === 'char').map((e) => e.keyCode);
  assert.deepStrictEqual(chars, ['h', 'i']);
});

test('type with submit appends a Return keypress', async () => {
  const wc = fakeWc({ executeJavaScript: async () => ({ x: 1, y: 1 }) });
  await build(wc).type('ref_1', 'hi', true);
  assert.ok(wc.sent.some((e) => e.type === 'char' && e.keyCode === 'Return'));
});

test('consoleErrors reports the buffer contents', async () => {
  const errors = createErrorBuffer(() => {});
  errors.push({ kind: 'console', level: 'error', message: 'boom', source: 'a.js', line: 1 });
  const actions = createActions({ getWebContents: () => fakeWc(), errors });
  assert.match(await actions.consoleErrors(), /boom/);
});

test('consoleErrors says so when the buffer is empty', async () => {
  assert.match(await build(fakeWc()).consoleErrors(), /no errors/i);
});

test('evaluate returns the JSON-serialized result', async () => {
  const wc = fakeWc({ executeJavaScript: async () => ({ ok: true }) });
  assert.strictEqual(await build(wc).evaluate('window.x'), '{"ok":true}');
});

test('every action fails clearly when there is no webContents', async () => {
  const actions = createActions({ getWebContents: () => null, errors: createErrorBuffer(() => {}) });
  await assert.rejects(() => actions.snapshot(), /no browser/i);
});
