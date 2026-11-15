// Run: node gh-meter.test.js
const assert = require('assert');
const { createGhMeter, callerOf } = require('./gh-meter');

// the first frame past the gh wrappers names the feature
const stack = `Error
    at metered (C:\\o\\main.js:10:5)
    at ghJsonRaw (C:\\o\\main.js:3340:3)
    at Object.ghJson (C:\\o\\gh-cache.js:49:14)
    at api (C:\\o\\rc-main.js:56:30)
    at async pollRcFixNow (C:\\o\\releases-main.js:510:7)`;
assert.strictEqual(callerOf(stack), 'releases-main:pollRcFixNow');
assert.strictEqual(callerOf('Error\n    at C:\\o\\main.js:5:1'), 'main:(anonymous)');
assert.strictEqual(callerOf('Error'), 'unknown');

const m = createGhMeter();
assert.strictEqual(m.report(), null);
m.meter('rest', stack); m.meter('rest', stack); m.meter('graphql', 'Error\n    at pollPrs (C:\\o\\main.js:2887:1)'); m.meter('free', stack);
assert.strictEqual(m.report(), 'gh calls, last 10 min: 2 rest, 1 graphql, 1 free (304) · top: rest releases-main:pollRcFixNow 2, graphql main:pollPrs 1');
assert.strictEqual(m.report(), null); // counts start over

console.log('gh-meter: ok');
