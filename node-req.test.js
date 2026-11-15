const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { minMajor, nodeRequirement, checkNode } = require('./node-req');

test('minMajor reads the lowest Node major a requirement accepts', () => {
  assert.strictEqual(minMajor('>=22.0.0'), 22);
  assert.strictEqual(minMajor('^20.11'), 20);
  assert.strictEqual(minMajor('~18.2.0'), 18);
  assert.strictEqual(minMajor('24.22.2'), 24);
  assert.strictEqual(minMajor('v24'), 24);
  assert.strictEqual(minMajor('20.x'), 20);
  assert.strictEqual(minMajor('^18 || ^20 || >=22'), 18);
  assert.strictEqual(minMajor('>= 16 < 21'), 16);
  assert.strictEqual(minMajor('lts/*'), null);
  assert.strictEqual(minMajor(''), null);
});

function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-req-'));
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c);
  return dir;
}

test('nodeRequirement takes the strictest of .nvmrc, .node-version and engines.node', () => {
  assert.deepStrictEqual(nodeRequirement(repo({ 'package.json': '{"engines":{"node":">=20"}}', '.nvmrc': '24.22.2\n' })), { major: 24, source: '.nvmrc' });
  assert.deepStrictEqual(nodeRequirement(repo({ 'package.json': '{"engines":{"node":">=22"}}' })), { major: 22, source: 'package.json' });
  assert.deepStrictEqual(nodeRequirement(repo({ '.node-version': '18' })), { major: 18, source: '.node-version' });
  assert.strictEqual(nodeRequirement(repo({ 'package.json': '{}' })), null);
  assert.strictEqual(nodeRequirement(path.join(os.tmpdir(), 'no-such-repo-xyz')), null);
});

test('a repo whose lockfile needs more than it declares is caught too', () => {
  // frontline declared nothing, but a locked package needed Node 22: npm's engine check failed the install.
  const lock = { packages: { '': {}, 'node_modules/@azure/core-process': { engines: { node: '>=22.0.0' } }, 'node_modules/x': { engines: { node: '>=14' } } } };
  assert.deepStrictEqual(nodeRequirement(repo({ 'package.json': '{}', 'package-lock.json': JSON.stringify(lock) })), { major: 22, source: '@azure/core-process' });
});

test('checkNode compares with the installed version', () => {
  assert.deepStrictEqual(checkNode({ major: 24, source: '.nvmrc' }, 'v20.20.0'), { ok: false, need: 24, have: '20.20.0', source: '.nvmrc' });
  assert.deepStrictEqual(checkNode({ major: 22, source: 'package.json' }, 'v24.22.1'), { ok: true, need: 22, have: '24.22.1', source: 'package.json' });
  assert.deepStrictEqual(checkNode(null, 'v20.0.0'), { ok: true, need: null, have: '20.0.0', source: null });
  assert.deepStrictEqual(checkNode({ major: 22, source: 'x' }, ''), { ok: false, need: 22, have: null, source: 'x' });
});
