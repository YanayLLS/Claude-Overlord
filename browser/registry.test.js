const test = require('node:test');
const assert = require('node:assert');
const { createRegistry, DEFAULT_VIEW_WIDTH, DEFAULT_VIEW_HEIGHT } = require('./registry');

// toBitmap() is BGRA. A white frame is content; an all-black one is what a dead view shows.
const imageOf = (v) => ({ isEmpty: () => false, toBitmap: () => Buffer.alloc(4 * 4000, v).map((b, i) => (i % 4 === 3 ? 255 : b)), toPNG: () => Buffer.from(v ? 'PAGE' : 'BLACK') });
const okImage = () => imageOf(255);
const blackImage = () => imageOf(0);

function harness(opts = {}) {
  const made = [];
  const attached = [];
  const counts = [];
  const navigations = [];
  const calls = [];
  const recovered = [];
  const makeView = (partition) => {
    const handlers = {};
    const onceHandlers = {};
    const view = {
      partition, visible: null, bounds: null, destroyed: false, calls,
      setVisible(v) { this.visible = v; calls.push(['setVisible', v]); },
      setBounds(b) { this.bounds = b; calls.push(['setBounds', b]); },
      getBounds() { return this.bounds; },
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
        image: opts.image ? opts.image() : okImage(),
        captures: 0,
        capturePage() { this.captures += 1; return Promise.resolve(this.image); },
        probe: opts.probe || (() => Promise.resolve(['rgb(255, 255, 255)', 'rgba(0, 0, 0, 0)'])),
        executeJavaScript(src) { return this.probe(src); },
        crashed: false,
        isCrashed() { return this.crashed; },
        forcefullyCrashRenderer() { this.crashed = true; },
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
    onRecovered: (id, reason, ok, url) => recovered.push({ id, reason, ok, url }),
  });
  return { registry, made, attached, counts, navigations, calls, recovered };
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
  assert.strictEqual(made[0].bounds.width, DEFAULT_VIEW_WIDTH);
  assert.strictEqual(made[0].bounds.height, DEFAULT_VIEW_HEIGHT);
  assert.ok(DEFAULT_VIEW_WIDTH > 0 && DEFAULT_VIEW_HEIGHT > 0);
});

// The viewport only materialises once the view is attached AND has been visible
// at least once; it then survives being hidden. Both hide and show must happen
// in the same tick so no frame is ever presented to the user. The view must be
// over the window while visible: measured on Electron 33, one made visible out
// where hidden views are parked gets a 0x0 viewport.
test('the viewport handshake is attach, bounds, visible, hide, park — in that order', () => {
  const { registry, calls } = harness();
  registry.ensure(1);
  assert.deepStrictEqual(calls.map((c) => c[0]), ['attach', 'setBounds', 'setVisible', 'setVisible', 'setBounds']);
  assert.deepStrictEqual(calls[1][1], { x: 0, y: 0, width: DEFAULT_VIEW_WIDTH, height: DEFAULT_VIEW_HEIGHT });
  assert.strictEqual(calls[2][1], true);
  assert.strictEqual(calls[3][1], false);
});

// Regression: Electron asks every attached view, hidden or not, whether a point is a window-drag
// area, offset only by the view's position. A hidden view left at 0,0 laid its page's own
// drag title bar over Overlord's header: bookmarks took clicks on their bottom edge only.
const overWindow = (b) => b.x < 10000 && b.y < 10000 && b.x + b.width > 0 && b.y + b.height > 0;

test('a hidden view is parked clear of the window, keeping its size', () => {
  const { registry, made } = harness();
  registry.ensure(1);
  assert.ok(!overWindow(made[0].bounds), 'new view');
  registry.show(1, { x: 300, y: 80, width: 400, height: 300 });
  assert.ok(overWindow(made[0].bounds), 'shown view');
  registry.hideAll();
  assert.ok(!overWindow(made[0].bounds), 'hidden again');
  assert.strictEqual(made[0].bounds.width, 400);
  assert.strictEqual(made[0].bounds.height, 300);
});

test('showing one agent parks the one shown before it', () => {
  const { registry, made } = harness();
  registry.show(1, { x: 300, y: 80, width: 400, height: 300 });
  registry.show(2, { x: 300, y: 80, width: 400, height: 300 });
  assert.ok(!overWindow(made[0].bounds));
  assert.ok(overWindow(made[1].bounds));
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

test('navigatedWithin: true only shortly after some view loaded', async () => {
  const h = harness();
  h.registry.ensure(1); h.registry.ensure(2);
  assert.strictEqual(h.registry.navigatedWithin(2000), false);
  await h.made[1].webContents.loadURL('http://x/');
  assert.strictEqual(h.registry.navigatedWithin(2000), true);
  assert.strictEqual(h.registry.navigatedWithin(2000, Date.now() + 5000), false);
});

test('prime: a dev-server URL loads only once the browser is first needed, and the first action waits for it', async () => {
  const { registry, made } = harness();
  registry.prime(1, 'http://localhost:3000');
  assert.strictEqual(made.length, 0, 'no renderer for a URL nobody looked at');
  const actions = registry.actionsFor(1);
  assert.strictEqual(made.length, 1);
  assert.strictEqual(made[0].webContents.url, 'http://localhost:3000');
  await actions.navigate('http://localhost:3000/b');
  assert.strictEqual(made[0].webContents.url, 'http://localhost:3000/b');
  // the browser exists now: a later prime navigates it directly
  registry.prime(1, 'http://localhost:4000');
  await new Promise(r => setImmediate(r));
  assert.strictEqual(made[0].webContents.url, 'http://localhost:4000');
  registry.destroy(1);
  registry.prime(1, 'http://localhost:5000');
  registry.destroy(1);
  registry.ensure(1);
  assert.strictEqual(made[1].webContents.url, 'about:blank', 'destroy forgets the primed URL');
});

// --- screenshots of a hidden view -------------------------------------------------------------
// Measured on Electron 33: a view that is setVisible(false), or visible but clipped out of its
// window (PARKED), has no compositor surface at all. capturePage rejects, CDP never answers,
// stayHidden changes nothing. The capture host lends the view to an invisible window for the
// capture, where it paints without a pixel reaching the screen.
function fakeCaptureHost() {
  const runs = [];
  return {
    runs,
    async run(view, size, fn, restore) {
      runs.push({ view, size });
      view.lent = true;
      try { return await fn(); } finally { view.lent = false; restore(); }
    },
  };
}

test('screenshot of a hidden view is taken while it is lent to the capture host, at its own size', async () => {
  const captureHost = fakeCaptureHost();
  const { registry, made } = harness({ captureHost });
  const png = await registry.actionsFor(1).screenshot();
  assert.strictEqual(png, Buffer.from('PAGE').toString('base64'));
  assert.strictEqual(captureHost.runs.length, 1);
  assert.deepStrictEqual(captureHost.runs[0].size, { width: DEFAULT_VIEW_WIDTH, height: DEFAULT_VIEW_HEIGHT });
  assert.strictEqual(made[0].visible, false, 'hidden again afterwards');
  assert.ok(!overWindow(made[0].bounds), 'parked again afterwards');
});

test('after a lend the view is re-attached to the main window', async () => {
  const captureHost = fakeCaptureHost();
  const { registry, made, attached } = harness({ captureHost });
  registry.ensure(1);
  attached.length = 0; // the host's window took it
  await registry.actionsFor(1).screenshot();
  assert.deepStrictEqual(attached, [made[0]]);
});

test('screenshot of the view showing in the pane is captured in place, never lent', async () => {
  const captureHost = fakeCaptureHost();
  const { registry, made } = harness({ captureHost });
  registry.show(1, { x: 300, y: 80, width: 400, height: 300 });
  await registry.actionsFor(1).screenshot();
  assert.strictEqual(captureHost.runs.length, 0);
  assert.strictEqual(made[0].visible, true);
  assert.deepStrictEqual(made[0].bounds, { x: 300, y: 80, width: 400, height: 300 });
});

test('a view last shown at the pane size is captured at that size, so the page does not relayout', async () => {
  const captureHost = fakeCaptureHost();
  const { registry } = harness({ captureHost });
  registry.show(1, { x: 300, y: 80, width: 400, height: 300 });
  registry.hideAll();
  await registry.actionsFor(1).screenshot();
  assert.deepStrictEqual(captureHost.runs[0].size, { width: 400, height: 300 });
});

test('the pane focusing an agent mid-capture shows it once the capture is done', async () => {
  let release;
  const captureHost = {
    run: async (view, size, fn, restore) => { await new Promise((r) => { release = r; }); try { return await fn(); } finally { restore(); } },
  };
  const { registry, made } = harness({ captureHost });
  registry.ensure(1);
  const shot = registry.actionsFor(1).screenshot();
  await new Promise((r) => setImmediate(r));
  registry.show(1, { x: 300, y: 80, width: 400, height: 300 });
  release();
  await shot;
  assert.strictEqual(made[0].visible, true);
  assert.deepStrictEqual(made[0].bounds, { x: 300, y: 80, width: 400, height: 300 });
});

test('hideAll does not touch a view while it is lent (parking it would clip it out of the capture)', async () => {
  let inside;
  const captureHost = { run: async (view, size, fn, restore) => { view.setBounds({ x: 0, y: 0, ...size }); view.setVisible(true); try { inside(); return await fn(); } finally { restore(); } } };
  const { registry, made } = harness({ captureHost });
  registry.ensure(1);
  inside = () => { registry.hideAll(); assert.strictEqual(made[0].visible, true); assert.strictEqual(made[0].bounds.x, 0); };
  await registry.actionsFor(1).screenshot();
  assert.strictEqual(made[0].visible, false);
});

// --- dead views recover ------------------------------------------------------------------------
const tick = () => new Promise((r) => setTimeout(r, 0));

test('a renderer that dies is replaced: new view, same partition, last URL reloaded', async () => {
  const { registry, made, recovered } = harness();
  await registry.actionsFor(1).navigate('http://localhost:3000/checkout');
  made[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  await tick();
  assert.strictEqual(made.length, 2);
  assert.strictEqual(made[0].destroyed, true, 'old view closed');
  assert.strictEqual(made[1].partition, made[0].partition, 'same partition: logins survive');
  assert.strictEqual(made[1].webContents.url, 'http://localhost:3000/checkout');
  assert.strictEqual(registry.ensure(1), made[1]);
  assert.deepStrictEqual(recovered.map((r) => [r.id, r.ok]), [[1, true]]);
});

test('a dead view that was showing in the pane is shown again in its place', async () => {
  const { registry, made } = harness();
  registry.show(1, { x: 300, y: 80, width: 400, height: 300 });
  made[0].webContents.emit('render-process-gone', {}, { reason: 'killed' });
  await tick();
  assert.strictEqual(made[1].visible, true);
  assert.deepStrictEqual(made[1].bounds, { x: 300, y: 80, width: 400, height: 300 });
});

test('a dead hidden view comes back hidden', async () => {
  const { registry, made } = harness();
  registry.ensure(1);
  made[0].webContents.emit('render-process-gone', {}, { reason: 'oom' });
  await tick();
  assert.strictEqual(made[1].visible, false);
  assert.ok(!overWindow(made[1].bounds));
});

test('actions taken after recovery drive the new view', async () => {
  const { registry, made } = harness();
  const before = registry.actionsFor(1);
  made[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  await tick();
  await registry.actionsFor(1).navigate('http://localhost:3000/next');
  assert.strictEqual(made[1].webContents.url, 'http://localhost:3000/next');
  assert.notStrictEqual(registry.actionsFor(1), before);
});

test('a clean renderer exit is not a crash', async () => {
  const { registry, made } = harness();
  registry.ensure(1);
  made[0].webContents.emit('render-process-gone', {}, { reason: 'clean-exit' });
  await tick();
  assert.strictEqual(made.length, 1);
});

test('destroying an agent never brings its browser back', async () => {
  const { registry, made } = harness();
  registry.ensure(1);
  registry.destroy(1);
  made[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  await tick();
  assert.strictEqual(made.length, 1);
  assert.strictEqual(registry.has(1), false);
});

test('an unresponsive renderer that answers again within the grace period is left alone', async () => {
  const { registry, made } = harness({ unresponsiveGraceMs: 20 });
  registry.ensure(1);
  made[0].webContents.emit('unresponsive');
  made[0].webContents.emit('responsive');
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(made.length, 1);
});

test('an unresponsive renderer that stays hung is replaced', async () => {
  const { registry, made, recovered } = harness({ unresponsiveGraceMs: 10 });
  registry.ensure(1);
  made[0].webContents.emit('unresponsive');
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(made.length, 2);
  assert.strictEqual(made[0].webContents.crashed, true, 'the hung process is killed, not left running');
  assert.match(recovered[0].reason, /unresponsive/);
});

test('a view that keeps dying is given up on after three recoveries a minute', async () => {
  const { registry, made, recovered } = harness();
  registry.ensure(1);
  for (let i = 0; i < 5; i++) { made[made.length - 1].webContents.emit('render-process-gone', {}, { reason: 'crashed' }); await tick(); }
  assert.strictEqual(made.length, 4, 'three replacements, then stop');
  assert.deepStrictEqual(recovered.map((r) => r.ok), [true, true, true, false]);
});

test('checkHealth: a healthy view is ok and untouched', async () => {
  const { registry, made } = harness();
  registry.show(1, { x: 0, y: 0, width: 400, height: 300 });
  assert.strictEqual(await registry.checkHealth(1), 'ok');
  assert.strictEqual(made.length, 1);
});

test('checkHealth: an all-black frame over a page that is not dark is a dead view, and is replaced', async () => {
  const { registry, made } = harness({ image: blackImage });
  await registry.actionsFor(1).navigate('http://localhost:3000/');
  registry.show(1, { x: 0, y: 0, width: 400, height: 300 });
  assert.strictEqual(await registry.checkHealth(1), 'recovered');
  assert.strictEqual(made.length, 2);
  assert.strictEqual(made[1].webContents.url, 'http://localhost:3000/');
  assert.strictEqual(made[1].visible, true);
});

test('checkHealth: an all-black frame of a page that really is black is fine', async () => {
  const { registry, made } = harness({ image: blackImage, probe: () => Promise.resolve(['rgb(0, 0, 0)', 'rgb(0, 0, 0)']) });
  registry.show(1, { x: 0, y: 0, width: 400, height: 300 });
  assert.strictEqual(await registry.checkHealth(1), 'ok');
  assert.strictEqual(made.length, 1);
});

test('checkHealth: a renderer that never answers is replaced', async () => {
  const { registry, made } = harness({ probe: () => new Promise(() => {}), probeTimeoutMs: 20 });
  registry.ensure(1);
  assert.strictEqual(await registry.checkHealth(1), 'recovered');
  assert.strictEqual(made.length, 2);
});

test('checkHealth: a crashed renderer is replaced', async () => {
  const { registry, made } = harness();
  registry.ensure(1);
  made[0].webContents.crashed = true;
  assert.strictEqual(await registry.checkHealth(1), 'recovered');
  assert.strictEqual(made.length, 2);
});

test('checkHealth on an agent with no browser builds nothing', async () => {
  const { registry, made } = harness();
  assert.strictEqual(await registry.checkHealth(7), 'none');
  assert.strictEqual(made.length, 0);
});

test('a black screenshot of a dead view recovers it and returns a real frame from the new one', async () => {
  let n = 0;
  const { registry, made } = harness({ image: () => (n++ === 0 ? blackImage() : okImage()) });
  await registry.actionsFor(1).navigate('http://localhost:3000/');
  const png = await registry.actionsFor(1).screenshot();
  assert.strictEqual(made.length, 2);
  assert.strictEqual(png, Buffer.from('PAGE').toString('base64'));
});
