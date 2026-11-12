const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { cookieUrl, oldJars, migrateJars } = require('./jar-migrate');

test('cookie urls follow secure, domain and path', () => {
  assert.strictEqual(cookieUrl({ secure: true, domain: '.lvh.me', path: '/api' }), 'https://lvh.me/api');
  assert.strictEqual(cookieUrl({ secure: false, domain: 'localhost' }), 'http://localhost/');
});

test('old per-agent jars are copied into the shared one once, newest last', async () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'jar-')), P = path.join(ud, 'Partitions');
  fs.mkdirSync(path.join(P, 'overlord-agent-old'), { recursive: true }); fs.mkdirSync(path.join(P, 'overlord-agent-new')); fs.mkdirSync(path.join(P, 'other'));
  fs.utimesSync(path.join(P, 'overlord-agent-old'), 1, 1);
  assert.deepStrictEqual(oldJars(P), ['overlord-agent-old', 'overlord-agent-new']);
  const set = [], jars = { 'persist:overlord-agent-old': [{ name: 'sid', value: 'a', domain: 'lvh.me', hostOnly: true, path: '/', secure: true }], 'persist:overlord-agent-new': [{ name: 'sid', value: 'b', domain: 'lvh.me', hostOnly: true, path: '/', secure: true }] };
  const session = { fromPartition: (p) => ({ cookies: { get: async () => jars[p] || [], set: async (c) => set.push(c), flushStore: async () => {} } }) };
  assert.strictEqual(await migrateJars({ session, userData: ud, target: 'persist:overlord-browser' }), 2);
  assert.strictEqual(set[set.length - 1].value, 'b');
  assert.strictEqual(await migrateJars({ session, userData: ud, target: 'persist:overlord-browser' }), 0);
  fs.rmSync(ud, { recursive: true, force: true });
});
