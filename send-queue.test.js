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

  // Two messages sent back to back (the second while the first is still pasting) arrive whole, one after the other;
  // a message's images stay where its text put them.
  const long = 'x'.repeat(5000);
  const a = send.parts(1, [{ text: 'compare ' }, { image: 'C:/s/a.png' }, { text: ' with ' + long }, { image: 'C:/s/b.png' }]);
  const b = send.prompt(1, 'second message', 3);
  await Promise.all([a, b]);
  const seq = writes.map(([, s]) => short(s));
  assert.deepStrictEqual(seq, ['«compare »', '«C:/s/a.png»', `« with ${long}»`, '«C:/s/b.png»', '\r', '^E⌫3', '«second message»', '\r'], 'in order, whole, one message at a time');
  // the long paste settles before the next paste lands on it
  assert.ok(writes[3][0] - writes[2][0] >= 400, 'a long paste gets time to settle before the image after it');

  // Different agents don't wait on each other.
  writes.length = 0;
  await Promise.all([send.prompt(2, 'to two'), send.prompt(3, 'to three')]);
  assert.strictEqual(writes.filter(([, s]) => s === '\r').length, 2);

  // Esc: what's still waiting is dropped, one being pasted is never submitted; later sends go as usual.
  writes.length = 0;
  const first = send.parts(4, [{ text: 'being pasted' }, { image: 'C:/s/c.png' }]);
  const waiting = send.prompt(4, 'still waiting');
  send.cancel(4);
  const after = send.prompt(4, 'sent after Esc');
  await Promise.all([first, waiting, after]);
  const s4 = writes.map(([, s]) => short(s));
  assert.ok(!s4.includes('«still waiting»'), 'a waiting message is dropped');
  assert.deepStrictEqual(s4.filter(s => s === '\r').length, 1, 'only the message sent after Esc is submitted');
  assert.ok(s4.includes('«sent after Esc»'));

  // Esc while a long paste is still going in, piece by piece: the Esc lands after its last piece, never inside it;
  // the cancelled message isn't submitted and its /clear isn't acted on, the next one's is.
  writes.length = 0;
  const pieces = [];
  const chunky = makeSender({ getTerm: () => ({ write: (s) => pieces.push(s) }), wait, writeChunked: async (t, s) => { for (let i = 0; i < s.length; i += 1024) { t.write(s.slice(i, i + 1024)); await wait(8); } } });
  const acted = [];
  const big = chunky.prompt(5, '/clear ' + 'y'.repeat(4000), 0, () => acted.push('first'));
  await null; await null; // the paste has started
  chunky.cancel(5);
  const next = chunky.prompt(5, '/clear', 0, () => acted.push('second'));
  await Promise.all([big, next]); await new Promise(r => setTimeout(r, 0));
  const escAt = pieces.indexOf('\x1b'), lastPiece = pieces.findIndex(p => p.includes('\x1b[201~'));
  assert.ok(lastPiece >= 0 && escAt > lastPiece, 'the Esc comes after the whole paste');
  assert.ok(pieces.slice(0, lastPiece).length >= 3, 'the first message really was mid-paste (several pieces) when Esc came');
  assert.deepStrictEqual(acted, ['second'], 'only a message really sent has its command acted on');

  // A send that throws doesn't block the ones after it.
  const bad = makeSender({ getTerm: (id) => (id === 9 ? { write: () => { throw new Error('pty gone'); } } : term), wait });
  writes.length = 0;
  await bad.prompt(9, 'lost'); await bad.prompt(1, 'still goes');
  assert.ok(writes.some(([, s]) => s.includes('still goes')));

  console.log('send-queue: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
