const test = require('node:test');
const assert = require('node:assert');
const { createPreviewController } = require('./preview-pane');
const { createErrorBuffer } = require('./browser/errors');

// A registry stand-in that records every creation, so "did showing the pane
// build a view for a dead agent?" is directly observable.
function fakeRegistry() {
  const views = new Map();
  const created = [];
  const shown = [];
  let hideAllCalls = 0;
  const reg = {
    created, shown, views,
    hideAllCalls: () => hideAllCalls,
    ensure(id) {
      if (!views.has(id)) {
        created.push(id);
        views.set(id, {
          errors: createErrorBuffer(() => {}),
          navigated: [],
          reloads: 0,
          ua: `native-ua-for-${id}`,
          webContents: {
            getURL: () => views.get(id).url || 'http://current/page',
            getUserAgent: () => views.get(id).ua,
            setUserAgent: (v) => { views.get(id).ua = v; },
            reload: () => { views.get(id).reloads++; },
          },
        });
      }
      return views.get(id);
    },
    has: (id) => views.has(id),
    show: (id, b) => { reg.ensure(id); shown.push([id, b]); },
    hideAll: () => { hideAllCalls++; },
    errorsFor: (id) => reg.ensure(id).errors,
    actionsFor: (id) => ({ navigate: async (u) => { reg.ensure(id).navigated.push(u); } }),
  };
  return reg;
}

function build({ alive = [1, 2, 3] } = {}) {
  const registry = fakeRegistry();
  const sent = [];
  const written = [];
  const liveSet = new Set(alive);
  const preview = createPreviewController({
    window: null,
    registry,
    send: (m) => sent.push(m),
    writeToAgent: (id, text) => written.push([id, text]),
    isAlive: (id) => liveSet.has(id),
  });
  return { preview, registry, sent, written, kill: (id) => liveSet.delete(id) };
}

const BOUNDS = { x: 0, y: 0, width: 400, height: 300 };

test('showing a focused agent displays its view inside the pane rect', () => {
  const { preview, registry } = build();
  preview.setBounds(BOUNDS);
  preview.show();
  preview.setAgent(2);
  assert.deepStrictEqual(registry.shown[registry.shown.length - 1], [2, BOUNDS]);
});

// Regression: nothing cleared preview.agentId when an agent closed, so a window
// resize — which fires previewSetBounds continuously — rebuilt a WebContentsView,
// session partition and error buffer per frame for an agent that no longer exists.
test('a closed agent is not resurrected by the resize storm that follows', () => {
  const { preview, registry, kill } = build();
  preview.show();
  preview.setBounds(BOUNDS);
  preview.setAgent(3);
  const before = registry.created.length;
  kill(3);
  preview.onAgentClosed(3);
  for (let i = 0; i < 20; i++) preview.setBounds({ ...BOUNDS, width: 400 + i });
  assert.strictEqual(registry.created.length, before, 'no view may be created for a dead agent');
});

test('bounds updates for a dead agent still work if onAgentClosed was never called', () => {
  const { preview, registry, kill } = build();
  preview.show();
  preview.setBounds(BOUNDS);
  preview.setAgent(3);
  const before = registry.created.length;
  kill(3); // liveness check alone must be enough
  preview.setBounds({ ...BOUNDS, width: 401 });
  assert.strictEqual(registry.created.length, before);
});

test('setAgent refuses an id that is not a live agent', () => {
  const { preview, registry } = build({ alive: [1] });
  preview.show();
  preview.setBounds(BOUNDS);
  preview.setAgent(9);
  assert.deepStrictEqual(registry.created, []);
});

// Regression: focusing an agent used to navigate its view back to the detected
// root URL and clear its error buffer, invalidating every ref_N the agent held.
test('focusing an agent never navigates its working browser', () => {
  const { preview, registry } = build();
  preview.show();
  preview.setBounds(BOUNDS);
  preview.setAgent(1);
  preview.setAgent(2);
  preview.setAgent(1);
  assert.deepStrictEqual(registry.ensure(1).navigated, []);
  assert.deepStrictEqual(registry.ensure(2).navigated, []);
});

test('focusing an agent never clears its error buffer', () => {
  const { preview, registry } = build();
  preview.show();
  preview.setBounds(BOUNDS);
  registry.errorsFor(1).push({ kind: 'console', level: 'error', message: 'boom', source: 'a.js', line: 1 });
  preview.setAgent(1);
  preview.setAgent(2);
  preview.setAgent(1);
  assert.strictEqual(registry.errorsFor(1).count(), 1);
});

test('there is no clearUrl escape hatch that silently wipes an agent buffer', () => {
  const { preview } = build();
  assert.strictEqual(preview.clearUrl, undefined);
});

test('focusing an agent reports the URL its view is actually on', () => {
  const { preview, registry, sent } = build();
  preview.show();
  preview.setBounds(BOUNDS);
  registry.ensure(1).url = 'http://localhost:3000/checkout';
  preview.setAgent(1);
  const loaded = sent.filter((m) => m.type === 'previewLoaded');
  assert.deepStrictEqual(loaded[loaded.length - 1], { type: 'previewLoaded', id: 1, url: 'http://localhost:3000/checkout' });
});

test('an explicit URL-bar navigation still navigates', () => {
  const { preview, registry } = build();
  preview.show();
  preview.setBounds(BOUNDS);
  preview.setAgent(1);
  preview.load('http://localhost:5173/');
  assert.deepStrictEqual(registry.ensure(1).navigated, ['http://localhost:5173/']);
});

test('load refuses a non-http url and a dead agent', () => {
  const { preview, registry, kill } = build();
  preview.show();
  preview.setBounds(BOUNDS);
  preview.setAgent(1);
  preview.load('file:///etc/passwd');
  kill(1);
  preview.load('http://localhost:5173/');
  assert.deepStrictEqual(registry.ensure(1).navigated, []);
});

// Regression: one shared defaultUA meant switching back to desktop on agent 2
// restored agent 1's user agent string.
test('each agent restores its own native user agent, not another agent\'s', () => {
  const { preview, registry } = build();
  preview.show();
  preview.setBounds(BOUNDS);
  preview.setAgent(1);
  preview.setDevice('mobile');
  preview.setAgent(2);
  preview.setDevice('ipad');
  preview.setDevice('desktop');
  assert.strictEqual(registry.ensure(2).webContents.getUserAgent(), 'native-ua-for-2');
  assert.match(registry.ensure(1).webContents.getUserAgent(), /iPhone/);
});

test('re-applying the device an agent already has does not reload its page', () => {
  const { preview, registry } = build();
  preview.show();
  preview.setBounds(BOUNDS);
  preview.setAgent(1);
  preview.setDevice('desktop');
  preview.setDevice('desktop');
  assert.strictEqual(registry.ensure(1).reloads, 0);
});

test('sendErrors drains the buffer to the owning agent only', () => {
  const { preview, registry, written } = build();
  registry.errorsFor(2).push({ kind: 'console', level: 'error', message: 'boom', source: 'a.js', line: 1 });
  preview.sendErrors(2);
  assert.strictEqual(written.length, 1);
  assert.strictEqual(written[0][0], 2);
  assert.match(written[0][1], /boom/);
  assert.strictEqual(registry.errorsFor(2).count(), 0);
});

test('onAgentClosed forgets a non-focused agent without disturbing the pane', () => {
  const { preview, registry } = build();
  preview.show();
  preview.setBounds(BOUNDS);
  preview.setAgent(1);
  const shownBefore = registry.shown.length;
  preview.onAgentClosed(2);
  preview.setBounds(BOUNDS);
  assert.ok(registry.shown.length > shownBefore, 'agent 1 must still be presented');
});
