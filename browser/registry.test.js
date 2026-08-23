const test = require('node:test');
const assert = require('node:assert');
const { createRegistry, DEFAULT_VIEW_WIDTH, DEFAULT_VIEW_HEIGHT } = require('./registry');

function harness(opts = {}) {
  const made = [];
  const attached = [];
  const counts = [];
  const navigations = [];
  const calls = [];
  const makeView = (partition) => {
    const handlers = {};
    const onceHandlers = {};
    const view = {
      partition, visible: null, bounds: null, destroyed: false, calls,
      setVisible(v) { this.visible = v; calls.push(['setVisible', v]); },
      setBounds(b) { this.bounds = b; calls.push(['setBounds', b]); },
      webContents: {
        url: 'about:blank',
        reloads: 0,
        on: (evt, fn) => { handlers[evt] = fn; },
        once: (evt, fn) => { onceHandlers[evt] = fn; },
        close() { view.destroyed = true; },
        getURL() { return this.url; },
        loadURL(u) { this.url = u; handlers['did-navigate'] && handlers['did-navigate'](); handlers['did-finish-load'] && handlers['did-finish-load'](); return Promise.resolve(); },
        // The real re-bind load fires the same navigation events again.
        reload() {
          this.reloads += 1;
          handlers['did-navigate'] && handlers['did-navigate']();
          handlers['did-finish-load'] && handlers['did-finish-load']();
          setTimeout(() => onceHandlers['did-finish-load'] && onceHandlers['did-finish-load'](), 0);
        },
        emit: (evt, ...args) => handlers[evt] && handlers[evt](...args),
      },
    };
    made.push(view);
    return view;
  };
  const registry = createRegistry({
    ...opts,
    makeView,
    attach: (v) => { attached.push(v); calls.push(['attach']); },
    detach: (v) => { const i = attached.indexOf(v); if (i >= 0) attached.splice(i, 1); },
    onErrorCount: (id, count) => counts.push([id, count]),
    onNavigated: (id, url) => navigations.push([id, url]),
  });
  return { registry, made, attached, counts, navigations, calls };
}

test('ensure creates one view per agent with its own partition', () => {
  const { registry, made } = harness();
  registry.ensure(1);
  registry.ensure(2);
  assert.deepStrictEqual(made.map((v) => v.partition), ['persist:overlord-agent-1', 'persist:overlord-agent-2']);
});

test('ensure is idempotent', () => {
  const { registry, made } = harness();
  assert.strictEqual(registry.ensure(1), registry.ensure(1));
  assert.strictEqual(made.length, 1);
});

test('a new view starts attached but invisible', () => {
  const { registry, made, attached } = harness();
  registry.ensure(1);
  assert.strictEqual(made[0].visible, false);
  assert.deepStrictEqual(attached, [made[0]]);
});

// Regression: an invisible view that was never given bounds lays out at 0x0.
// window.innerWidth is 0, every block-level element measures zero width, and
// buildSnapshot skips zero-width elements — so the agent's snapshot came back
// empty or truncated. Measured on real Electron 33; see the fix report.
test('a new view is given a real default viewport, not left at 0x0', () => {
  const { registry, made } = harness();
  registry.ensure(1);
  assert.deepStrictEqual(made[0].bounds, { x: 0, y: 0, width: DEFAULT_VIEW_WIDTH, height: DEFAULT_VIEW_HEIGHT });
  assert.ok(DEFAULT_VIEW_WIDTH > 0 && DEFAULT_VIEW_HEIGHT > 0);
});

// The viewport only materialises once the view is attached AND has been visible
// at least once; it then survives being hidden. Both hide and show must happen
// in the same tick so no frame is ever presented to the user.
test('the viewport handshake is attach, bounds, visible, hide — in that order', () => {
  const { registry, calls } = harness();
  registry.ensure(1);
  assert.deepStrictEqual(calls.map((c) => c[0]), ['attach', 'setBounds', 'setVisible', 'setVisible']);
  assert.strictEqual(calls[2][1], true);
  assert.strictEqual(calls[3][1], false);
});

test('partitionFor is injectable, so partitions can be keyed off a stable id', () => {
  const { registry, made } = harness({ partitionFor: (id) => `persist:overlord-agent-uuid-${id}` });
  registry.ensure(3);
  assert.strictEqual(made[0].partition, 'persist:overlord-agent-uuid-3');
});

test('the injected partition is the one unwired on destroy', () => {
  const seen = [];
  const { registry } = harness({ partitionFor: (id) => { seen.push(id); return `persist:custom-${id}`; } });
  registry.ensure(5);
  assert.doesNotThrow(() => registry.destroy(5));
  assert.deepStrictEqual(seen, [5]);
});

test('show sets bounds and makes only that agent visible', () => {
  const { registry, made } = harness();
  registry.ensure(1); registry.ensure(2);
  registry.show(1, { x: 0, y: 0, width: 400, height: 300 });
  registry.show(2, { x: 0, y: 0, width: 400, height: 300 });
  assert.strictEqual(made[0].visible, false);
  assert.strictEqual(made[1].visible, true);
  assert.deepStrictEqual(made[1].bounds, { x: 0, y: 0, width: 400, height: 300 });
});

test('show rounds and floors negative bounds', () => {
  const { registry, made } = harness();
  registry.show(1, { x: -5, y: 10.6, width: 400.2, height: 300 });
  assert.deepStrictEqual(made[0].bounds, { x: 0, y: 11, width: 400, height: 300 });
});

test('hideAll leaves every view invisible but still attached', () => {
  const { registry, made, attached } = harness();
  registry.show(1, { x: 0, y: 0, width: 10, height: 10 });
  registry.hideAll();
  assert.strictEqual(made[0].visible, false);
  assert.strictEqual(attached.length, 1);
});

test('console errors are buffered per agent and reported by id', () => {
  const { registry, made, counts } = harness();
  registry.ensure(1);
  made[0].webContents.emit('console-message', {}, 'error', 'boom', 12, 'a.js');
  assert.strictEqual(registry.errorsFor(1).count(), 1);
  assert.deepStrictEqual(counts, [[1, 1]]);
});

test('console info and debug messages are ignored', () => {
  const { registry, made } = harness();
  registry.ensure(1);
  made[0].webContents.emit('console-message', {}, 'info', 'chatty', 1, 'a.js');
  assert.strictEqual(registry.errorsFor(1).count(), 0);
});

test('a main-frame load failure is buffered, an aborted one is not', () => {
  const { registry, made } = harness();
  registry.ensure(1);
  made[0].webContents.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', 'http://x', true);
  made[0].webContents.emit('did-fail-load', {}, -3, 'ABORTED', 'http://y', true);
  assert.strictEqual(registry.errorsFor(1).count(), 1);
});

test('did-finish-load notifies onNavigated with that agent id and its current URL', () => {
  const { registry, made, navigations } = harness();
  registry.ensure(1);
  made[0].webContents.url = 'http://x/a';
  made[0].webContents.emit('did-finish-load');
  assert.deepStrictEqual(navigations, [[1, 'http://x/a']]);
});

test('did-navigate notifies onNavigated with that agent id and its current URL', () => {
  const { registry, made, navigations } = harness();
  registry.ensure(1);
  made[0].webContents.url = 'http://x/b';
  made[0].webContents.emit('did-navigate', {}, 'http://x/b');
  assert.deepStrictEqual(navigations, [[1, 'http://x/b']]);
});

test('did-navigate-in-page notifies onNavigated with that agent id and its current URL', () => {
  const { registry, made, navigations } = harness();
  registry.ensure(1);
  made[0].webContents.url = 'http://x/c#frag';
  made[0].webContents.emit('did-navigate-in-page', {}, 'http://x/c#frag');
  assert.deepStrictEqual(navigations, [[1, 'http://x/c#frag']]);
});

test('navigation events are attributed to the agent that navigated, not other agents', () => {
  const { registry, made, navigations } = harness();
  registry.ensure(1); registry.ensure(2);
  made[1].webContents.url = 'http://two';
  made[1].webContents.emit('did-finish-load');
  assert.deepStrictEqual(navigations, [[2, 'http://two']]);
});

test('actionsFor returns a working actions object bound to that agent', () => {
  const { registry } = harness();
  const actions = registry.actionsFor(1);
  assert.strictEqual(typeof actions.navigate, 'function');
});

test('destroy closes the view, detaches it, and forgets the agent', () => {
  const { registry, made, attached } = harness();
  registry.ensure(1);
  registry.destroy(1);
  assert.strictEqual(made[0].destroyed, true);
  assert.deepStrictEqual(attached, []);
  assert.strictEqual(registry.has(1), false);
});

test('destroy unregisters the partition network-error listener without throwing (no Electron under test)', () => {
  const { registry } = harness();
  registry.ensure(1);
  assert.doesNotThrow(() => registry.destroy(1));
  assert.strictEqual(registry.has(1), false);
});

test('destroy on an unknown agent does not throw', () => {
  const { registry } = harness();
  assert.doesNotThrow(() => registry.destroy(42));
});

test('destroyAll clears every agent', () => {
  const { registry } = harness();
  registry.ensure(1); registry.ensure(2);
  registry.destroyAll();
  assert.strictEqual(registry.has(1), false);
  assert.strictEqual(registry.has(2), false);
});

// Regression, measured on Electron 33.4.11: after a view's FIRST navigation the
// child WebContentsView's input routing stays bound to the widget discarded in
// the about:blank -> http process swap. sendInputEvent is accepted and silently
// dropped, so browser_click and browser_type were inert on every agent's first
// page while still reporting success. Only a real second load re-binds it.
test('a view first navigation is followed by one input re-bind load', async () => {
  const { registry, made } = harness();
  await registry.actionsFor(1).navigate('http://localhost:3000/');
  assert.strictEqual(made[0].webContents.reloads, 1);
});

test('later navigations pay no re-bind cost', async () => {
  const { registry, made } = harness();
  const actions = registry.actionsFor(1);
  await actions.navigate('http://localhost:3000/');
  await actions.navigate('http://localhost:3000/two');
  await actions.navigate('http://localhost:3000/three');
  assert.strictEqual(made[0].webContents.reloads, 1);
});

// The re-bind load is an internal detail. One agent navigation must still look
// like one navigation to the pane, and must not re-record the first load's
// console errors.
test('the re-bind load raises no extra navigation notification', async () => {
  const { registry, navigations } = harness();
  const actions = registry.actionsFor(1);
  await actions.navigate('http://localhost:3000/');
  const afterFirst = navigations.length;
  navigations.length = 0;
  await actions.navigate('http://localhost:3000/two');
  assert.strictEqual(afterFirst, navigations.length, 'the re-bound navigation notifies no more than a plain one');
});

test('console errors from the re-bind load are not double-counted', async () => {
  const { registry, made } = harness();
  const actions = registry.actionsFor(1);
  const errors = registry.errorsFor(1);
  await actions.navigate('http://localhost:3000/');
  made[0].webContents.emit('console-message', {}, 'error', 'boom', 1, 'a.js');
  const before = errors.count();
  // A second navigate must not re-bind, so nothing is suppressed either.
  await actions.navigate('http://localhost:3000/two');
  assert.strictEqual(before, 1);
});
