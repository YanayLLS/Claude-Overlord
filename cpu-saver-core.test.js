const test = require('node:test');
const assert = require('node:assert');
const { keepAwake, dueToSleep } = require('./cpu-saver-core');

const idle = () => ({ claudeReady: true, isWaiting: true, bgTasks: new Set(), toolIds: new Set(), askIds: new Set(), cronCount: 0 });
const ctx = (over = {}) => ({ hasTerm: true, ...over });

test('an idle, unfocused agent with nothing running can sleep', () => {
  assert.strictEqual(keepAwake(idle(), ctx()), '');
});

test('anything still running, waiting or on its way keeps it awake', () => {
  const cases = [
    [{}, { focused: true }, 'open'],
    [{}, { hasTerm: false }, 'no Claude process'],
    [{}, { shell: true }, 'no Claude process'],
    [{ claudeReady: false }, {}, 'starting'],
    [{ crashed: 'resuming' }, {}, 'recovering'],
    [{ isWaiting: false }, {}, 'working'],
    [{ compacting: true }, {}, 'working'],
    [{ bgTasks: new Set(['b1']) }, {}, 'background shell or subagent'],
    [{ toolIds: new Set(['t1']) }, {}, 'tool running'],
    [{ ptyPerm: 'ask' }, {}, 'waiting on you'],
    [{ askIds: new Set(['q']) }, {}, 'waiting on you'],
    [{ cliMenu: true }, {}, 'waiting on you'],
    [{ pendingPrompt: { key: 'x' } }, {}, 'message on its way'],
    [{}, { unsent: true }, 'message on its way'],
    [{ archived: true }, {}, 'not running'],
    [{ sleeping: true }, {}, 'not running'],
  ];
  for (const [a, c, why] of cases) assert.strictEqual(keepAwake({ ...idle(), ...a }, ctx(c)), why, JSON.stringify(a) + JSON.stringify(c));
});

test('it sleeps only after a full idle stretch; any reason to stay awake restarts the clock', () => {
  const a = idle();
  assert.deepStrictEqual(dueToSleep([{ id: 1, a, why: '' }], 1000, 60000), []); // clock starts
  assert.deepStrictEqual(dueToSleep([{ id: 1, a, why: '' }], 60000, 60000), []);
  assert.deepStrictEqual(dueToSleep([{ id: 1, a, why: 'open' }], 61000, 60000), []); // you looked at it
  assert.deepStrictEqual(dueToSleep([{ id: 1, a, why: '' }], 62000, 60000), []);
  assert.deepStrictEqual(dueToSleep([{ id: 1, a, why: '' }], 122000, 60000), [1]);
});

test('by default it sleeps on the first sweep that finds it idle', () => {
  assert.deepStrictEqual(dueToSleep([{ id: 1, a: idle(), why: '' }, { id: 2, a: idle(), why: 'open' }], 5000), [1]);
});
