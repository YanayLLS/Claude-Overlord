const test = require('node:test');
const assert = require('node:assert');
const { createCaptureHost, CAPTURE_WINDOW_OPTIONS, makeCaptureWindow } = require('./capture-host');

function fakeWindow(log) {
  const children = [];
  return {
    children, destroyed: false, shown: false,
    isDestroyed() { return this.destroyed; },
    showInactive() { this.shown = true; log.push('showInactive'); },
    show() { throw new Error('show() would take focus'); },
    hide() { this.shown = false; log.push('hide'); },
    destroy() { this.destroyed = true; },
    contentView: {
      addChildView: (v) => { children.push(v); log.push('add'); },
      removeChildView: (v) => { const i = children.indexOf(v); if (i >= 0) children.splice(i, 1); log.push('remove'); },
    },
  };
}
const fakeView = (log) => ({
  visible: false, bounds: null,
  setVisible(v) { this.visible = v; log.push(`visible:${v}`); },
  setBounds(b) { this.bounds = b; log.push('bounds'); },
});
function harness() {
  const log = [];
  const windows = [];
  const host = createCaptureHost({ makeWindow: () => { const w = fakeWindow(log); windows.push(w); return w; } });
  return { host, log, windows, view: fakeView(log) };
}

test('run lends the view to the invisible window, visible at the given size, and returns what fn returns', async () => {
  const { host, windows, view } = harness();
  const out = await host.run(view, { width: 1280, height: 800 }, async () => {
    assert.ok(windows[0].children.includes(view), 'attached to the capture window during fn');
    assert.strictEqual(view.visible, true);
    assert.deepStrictEqual(view.bounds, { x: 0, y: 0, width: 1280, height: 800 });
    assert.strictEqual(windows[0].shown, true);
    return 'IMG';
  }, () => {});
  assert.strictEqual(out, 'IMG');
});

test('after run the view is hidden, back out of the window, the window hidden, and restore called', async () => {
  const { host, windows, view } = harness();
  let restored = 0;
  await host.run(view, { width: 10, height: 10 }, async () => {}, () => { restored++; });
  assert.strictEqual(view.visible, false);
  assert.deepStrictEqual(windows[0].children, []);
  assert.strictEqual(windows[0].shown, false);
  assert.strictEqual(restored, 1);
});

test('restore runs and the error propagates when fn throws', async () => {
  const { host, view } = harness();
  let restored = 0;
  await assert.rejects(() => host.run(view, { width: 10, height: 10 }, async () => { throw new Error('boom'); }, () => { restored++; }), /boom/);
  assert.strictEqual(restored, 1);
});

test('runs are serialized: a second lend waits for the first to finish', async () => {
  const { host, log } = harness();
  const a = fakeView(log); const b = fakeView(log);
  const order = [];
  let release;
  const first = host.run(a, { width: 1, height: 1 }, () => new Promise((r) => { order.push('a-start'); release = r; }), () => order.push('a-restore'));
  const second = host.run(b, { width: 1, height: 1 }, async () => { order.push('b-start'); }, () => order.push('b-restore'));
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(order, ['a-start']);
  release();
  await Promise.all([first, second]);
  assert.deepStrictEqual(order, ['a-start', 'a-restore', 'b-start', 'b-restore']);
});

test('one window, made lazily and reused; remade if it was destroyed', async () => {
  const { host, windows, view } = harness();
  assert.strictEqual(windows.length, 0);
  await host.run(view, { width: 1, height: 1 }, async () => {}, () => {});
  await host.run(view, { width: 1, height: 1 }, async () => {}, () => {});
  assert.strictEqual(windows.length, 1);
  windows[0].destroyed = true;
  await host.run(view, { width: 1, height: 1 }, async () => {}, () => {});
  assert.strictEqual(windows.length, 2);
});

test('destroy closes the window so it never keeps the app alive', async () => {
  const { host, windows, view } = harness();
  await host.run(view, { width: 1, height: 1 }, async () => {}, () => {});
  host.destroy();
  assert.strictEqual(windows[0].destroyed, true);
});

// The window must never be seen or take focus: fully transparent, click-through, off the taskbar.
test('the capture window is invisible, unfocusable, click-through and off the taskbar', () => {
  assert.strictEqual(CAPTURE_WINDOW_OPTIONS.show, false);
  assert.strictEqual(CAPTURE_WINDOW_OPTIONS.opacity, 0);
  assert.strictEqual(CAPTURE_WINDOW_OPTIONS.focusable, false);
  assert.strictEqual(CAPTURE_WINDOW_OPTIONS.skipTaskbar, true);
  assert.strictEqual(CAPTURE_WINDOW_OPTIONS.frame, false);
  const made = [];
  class BW { constructor(o) { this.o = o; made.push(this); } setIgnoreMouseEvents(v) { this.ignore = v; } }
  const w = makeCaptureWindow({ BrowserWindow: BW, screen: { getPrimaryDisplay: () => ({ workArea: { x: 5, y: 6, width: 100, height: 100 } }) } });
  assert.strictEqual(w.ignore, true);
  assert.strictEqual(w.o.opacity, 0);
  assert.strictEqual(w.o.x, 5);
  assert.strictEqual(w.o.y, 6);
});
