const test = require('node:test');
const assert = require('node:assert');
const { parseStartArgs, appendBuf, BUF_MAX } = require('./term-pane-core');

test('start-full.bat style: title, /D dir, cmd /k "command"', () => {
  assert.deepStrictEqual(parseStartArgs(['FL Backend (S3-wired)', '/D', 'C:\\Work\\web', 'cmd', '/k', 'npm run dev:local'], 'C:\\x'),
    { name: 'FL Backend (S3-wired)', cwd: 'C:\\Work\\web', mode: '/k', line: '"npm run dev:local"' });
});

test('no /D keeps the caller\'s folder; cmd /c is kept', () => {
  assert.deepStrictEqual(parseStartArgs(['FL Local S3', 'cmd', '/c', 'dev.bat'], 'C:\\D'), { name: 'FL Local S3', cwd: 'C:\\D', mode: '/c', line: 'dev.bat' });
});

test('a bare command (no cmd /k) runs under /k; args with shell characters are re-quoted', () => {
  assert.deepStrictEqual(parseStartArgs(['T', '/MIN', 'npm', 'run', 'a && b'], 'C:\\D'), { name: 'T', cwd: 'C:\\D', mode: '/k', line: 'npm run "a && b"' });
});

test('nothing to run is null', () => {
  assert.strictEqual(parseStartArgs(['T', '/D', 'C:\\x'], 'C:\\D'), null);
});

test('the output buffer keeps the newest BUF_MAX chars', () => {
  const b = appendBuf('x'.repeat(BUF_MAX), 'yz');
  assert.strictEqual(b.length, BUF_MAX);
  assert.ok(b.endsWith('yz'));
});

test('plainTail strips colours, keeps the last state of a \r progress line, tails and greps', () => {
  const { plainTail } = require('./term-pane-core');
  const buf = '\x1b]0;title\x07\x1b[32mready\x1b[0m on 5173\r\nloading 10%\rloading 100%\r\nERROR: boom\r\nok\r\n';
  assert.strictEqual(plainTail(buf), 'ready on 5173\nloading 100%\nERROR: boom\nok');
  assert.strictEqual(plainTail(buf, { lines: 2 }), 'ERROR: boom\nok');
  assert.strictEqual(plainTail(buf, { grep: 'error' }), 'ERROR: boom');
});
