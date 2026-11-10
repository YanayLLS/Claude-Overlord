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
