const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), crypto = require('crypto');
const { cleanText, download } = require('./whisper');

test('silence and noise come back as no words, not a dash', () => {
  for (const s of [' you', 'Thank you.', ' - ', '-', '...', ' [BLANK_AUDIO] ', '(wind blowing)', ' — ', '- [Music]']) assert.strictEqual(cleanText(s), '', JSON.stringify(s));
  assert.strictEqual(cleanText(' - Fix the bug.\n - Then commit.'), 'Fix the bug. Then commit.');
  assert.strictEqual(cleanText('Check the read-only flag - twice.'), 'Check the read-only flag - twice.'); // dashes inside a sentence stay
});

test('silence read back as the vocabulary hint is no words; a short real word from it stays', () => {
  const hint = 'overlord, chat-composer.js, useState, whisper.js';
  assert.strictEqual(cleanText(' overlord, chat-composer.js, useState.', hint), '');
  assert.strictEqual(cleanText(' useState', hint), 'useState');
  assert.strictEqual(cleanText(' Fix useState in chat-composer.js', hint), 'Fix useState in chat-composer.js');
});

test('a download resumes from its .part and is refused when the bytes do not match the pinned hash', async () => {
  const body = crypto.randomBytes(100000), sha = crypto.createHash('sha256').update(body).digest('hex'); let ranges = [];
  const srv = http.createServer((q, r) => {
    const m = /bytes=(\d+)-/.exec(q.headers.range || ''); ranges.push(q.headers.range || '');
    if (m) { r.writeHead(206, { 'content-length': body.length - +m[1] }); r.end(body.subarray(+m[1])); } else { r.writeHead(200); r.end(body); }
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const url = `http://127.0.0.1:${srv.address().port}/m`, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-')), f = path.join(dir, 'm.bin');
  try {
    fs.writeFileSync(f + '.part', body.subarray(0, 40000)); let got = 0;
    await download(url, f, sha, (n) => { got += n; });
    assert.deepStrictEqual(fs.readFileSync(f), body); assert.strictEqual(got, body.length); assert.deepStrictEqual(ranges, ['bytes=40000-']);
    fs.writeFileSync(f + '2.part', Buffer.alloc(40000)); // wrong bytes already on disk
    await assert.rejects(download(url, f + '2', sha, () => {}), /corrupted/);
    assert.ok(!fs.existsSync(f + '2.part') && !fs.existsSync(f + '2')); // thrown away, so the next try starts clean
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
