// Self-check for watch-core. Run: node watch-core.test.js
const assert = require('assert');
const w = require('./watch-core');

assert.deepStrictEqual(w.parseWhenDone('ok.\nWHEN-DONE @Zephyr: review its diff\nthen open the PR'),
  { agentName: 'Zephyr', task: 'review its diff\nthen open the PR' });
assert.deepStrictEqual(w.parseWhenDone('WHEN-DONE Nova: x'), { agentName: 'Nova', task: 'x' });
assert.strictEqual(w.parseWhenDone('when-done is a nice idea'), null);
assert.strictEqual(w.parseWhenDone('WHEN-DONE @Zephyr:   '), null);
assert.strictEqual(w.parseWhenDone('I said WHEN-DONE @Zephyr: x mid-line'), null);

assert.ok(w.turnIsDone('All green.\n\nI AM DONE'));
assert.ok(w.turnIsDone('I NEED YOU: which branch?'));
assert.ok(w.turnIsDone(''));
assert.ok(!w.turnIsDone('Started tests.\n\nI AM WORKING ETA ~14:25\n- running tests\n- then commit'));

const msg = w.buildWatchMessage('Zephyr', 'open the PR', 'Fixed.\nI AM DONE', false);
assert.ok(msg.startsWith(w.HEADER + ' @Zephyr finished its turn]'));
assert.ok(msg.includes('open the PR') && msg.includes('Fixed.\nI AM DONE'));
assert.ok(w.buildWatchMessage('Z', 't', '', true).includes('was already idle') );
console.log('watch-core ok');
