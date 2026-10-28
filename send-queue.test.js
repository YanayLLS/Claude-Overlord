// Run: node send-queue.test.js
const assert = require('assert');
const { makeSender } = require('./send-queue');

(async () => {
  const writes = []; let now = 0;
  const term = { write: (s) => writes.push([now, s]) };
  // a clock that only moves when the sender waits, so the order of writes is exact
  const wait = async (ms) => { now += ms; await null; };
  const send = makeSender({ getTerm: () => term, wait });
  const short = (s) => s.replace('\x1b[200~', '«').replace('\x1b[201~', '»').replace(/\x7f+/, (m) => `⌫${m.length}`).replace('\x05', '^E');

  // Two messages sent back to back (the second while the first is still pasting) arrive whole, one after the other.
  const long = 'x'.repeat(5000);
  const a = send.parts(1, [{ text: 'look: ' }, { text: long }, { image: 'C:/s/shot.png' }]);
  const b = send.prompt(1, 'second message', 3);
  await Promise.all([a, b]);
  const seq = writes.map(([, s]) => short(s));
  assert.deepStrictEqual(seq, ['«C:/s/shot.png»', `«look: ${long}»`, '\r', '^E⌫3', '«second message»', '\r'], 'image first, then all the text in one paste, Enter; only then the next message');
  // Enter waits for a long paste to be taken in
  const enterAt = writes[2][0], textAt = writes[1][0];
  assert.ok(enterAt - textAt >= 400, 'a long paste gets time to settle before Enter');

  // Different agents don't wait on each other.
  writes.length = 0;
  await Promise.all([send.prompt(2, 'to two'), send.prompt(3, 'to three')]);
  assert.strictEqual(writes.filter(([, s]) => s === '\r').length, 2);

  // A send that throws doesn't block the ones after it.
  const bad = makeSender({ getTerm: (id) => (id === 9 ? { write: () => { throw new Error('pty gone'); } } : term), wait });
  writes.length = 0;
  await bad.prompt(9, 'lost'); await bad.prompt(1, 'still goes');
  assert.ok(writes.some(([, s]) => s.includes('still goes')));

  console.log('send-queue: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
