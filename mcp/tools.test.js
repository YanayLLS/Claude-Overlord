const test = require('node:test');
const assert = require('node:assert');
const { TOOL_SCHEMAS, createDispatcher } = require('./tools');

function fakeActions(overrides = {}) {
  const calls = [];
  const base = {
    navigate: async (url) => { calls.push(['navigate', url]); return 'loaded ' + url; },
    snapshot: async () => { calls.push(['snapshot']); return 'button "Go" [ref_1]'; },
    screenshot: async () => { calls.push(['screenshot']); return 'QUJD'; },
    click: async (ref) => { calls.push(['click', ref]); return 'clicked ' + ref; },
    type: async (ref, text, submit) => { calls.push(['type', ref, text, submit]); return 'typed'; },
    consoleErrors: async () => { calls.push(['consoleErrors']); return 'no errors'; },
    evaluate: async (js) => { calls.push(['evaluate', js]); return '42'; },
  };
  return { actions: { ...base, ...overrides }, calls };
}

test('exposes exactly the eight browser tools', () => {
  const names = TOOL_SCHEMAS.map((t) => t.name).sort();
  assert.deepStrictEqual(names, [
    'browser_click', 'browser_console', 'browser_eval', 'browser_navigate',
    'browser_screenshot', 'browser_snapshot', 'browser_type', 'browser_viewport',
  ]);
});

test('every schema has a description and an object inputSchema', () => {
  for (const t of TOOL_SCHEMAS) {
    assert.ok(t.description.length > 10, `${t.name} needs a description`);
    assert.strictEqual(t.inputSchema.type, 'object');
  }
});

test('navigate passes the url through and returns a text block', async () => {
  const { actions, calls } = fakeActions();
  const res = await createDispatcher(actions)('browser_navigate', { url: 'http://localhost:3000' });
  assert.deepStrictEqual(calls, [['navigate', 'http://localhost:3000']]);
  assert.deepStrictEqual(res, { content: [{ type: 'text', text: 'loaded http://localhost:3000' }] });
});

test('screenshot returns an image block, not text', async () => {
  const { actions } = fakeActions();
  const res = await createDispatcher(actions)('browser_screenshot', {});
  assert.deepStrictEqual(res.content, [{ type: 'image', data: 'QUJD', mimeType: 'image/png' }]);
});

test('type forwards submit as a boolean, defaulting to false', async () => {
  const { actions, calls } = fakeActions();
  await createDispatcher(actions)('browser_type', { ref: 'ref_2', text: 'hi' });
  assert.deepStrictEqual(calls, [['type', 'ref_2', 'hi', false]]);
});

test('unknown tool name is an error result, not a throw', async () => {
  const { actions } = fakeActions();
  const res = await createDispatcher(actions)('browser_teleport', {});
  assert.strictEqual(res.isError, true);
  assert.match(res.content[0].text, /Unknown tool: browser_teleport/);
});

test('a missing required argument is an error result', async () => {
  const { actions } = fakeActions();
  const res = await createDispatcher(actions)('browser_click', {});
  assert.strictEqual(res.isError, true);
  assert.match(res.content[0].text, /ref/);
});

test('an action that throws becomes an error result', async () => {
  const { actions } = fakeActions({ navigate: async () => { throw new Error('ERR_CONNECTION_REFUSED'); } });
  const res = await createDispatcher(actions)('browser_navigate', { url: 'http://localhost:1' });
  assert.strictEqual(res.isError, true);
  assert.match(res.content[0].text, /ERR_CONNECTION_REFUSED/);
});

const { VISUAL_SCHEMAS, visualCall } = require('./tools');

test('show_visual: html or variants, and it only says where the visual went', () => {
  assert.deepStrictEqual(VISUAL_SCHEMAS.map((t) => t.name), ['show_visual']);
  const props = VISUAL_SCHEMAS[0].inputSchema.properties;
  assert.ok(props.html && props.variants && props.title);
  assert.deepStrictEqual(visualCall({ html: '<b>x</b>' }), { content: [{ type: 'text', text: 'Shown in the chat.' }] });
  assert.deepStrictEqual(visualCall({ variants: [{ label: 'A', html: 'a' }, { label: 'B', html: 'b' }] }), { content: [{ type: 'text', text: 'Shown in the chat (2 variants).' }] });
  assert.strictEqual(visualCall({}).isError, true);
  assert.strictEqual(visualCall({ variants: [{ label: 'A' }] }).isError, true);
});

test('browser_viewport hands width and height to the view', async () => {
  const { createDispatcher } = require('./tools');
  let got = null;
  const call = createDispatcher({ viewport: async (w, h) => { got = [w, h]; return 'ok'; } });
  const r = await call('browser_viewport', { width: 1440 });
  assert.deepStrictEqual(got, [1440, undefined]);
  assert.strictEqual(r.content[0].text, 'ok');
});
