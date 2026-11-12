const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { createLogins } = require('./logins');

const fakeCrypt = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('enc:' + s), decryptString: (b) => b.toString().slice(4) };

test('a login is kept per site, encrypted on disk, and read back', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lg-')), 'l.json');
  const l = createLogins({ file, safeStorage: fakeCrypt });
  assert.strictEqual(l.save('https://lvh.me:5173', 'me@x.io', 'pw1'), true);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('pw1'));
  assert.deepStrictEqual(createLogins({ file, safeStorage: fakeCrypt }).get('https://lvh.me:5173'), { user: 'me@x.io', pass: 'pw1' });
  assert.strictEqual(l.save('https://lvh.me:5173', '', 'pw2'), true); // password step alone keeps the username
  assert.deepStrictEqual(l.get('https://lvh.me:5173'), { user: 'me@x.io', pass: 'pw2' });
  assert.strictEqual(l.get('https://other'), null);
});

test('a saved login that keeps failing is not filled in a loop', () => {
  let t = 0; const l = createLogins({ file: path.join(os.tmpdir(), 'none-' + Date.now()), safeStorage: fakeCrypt, now: () => t });
  assert.strictEqual(l.mayFill('o'), true);
  t = 1000; assert.strictEqual(l.mayFill('o'), false); // too soon
  t = 10000; assert.strictEqual(l.mayFill('o'), true);
  t = 20000; assert.strictEqual(l.mayFill('o'), true);
  t = 30000; assert.strictEqual(l.mayFill('o'), false); // 3 in 2 minutes
  t = 200000; assert.strictEqual(l.mayFill('o'), true);
});
