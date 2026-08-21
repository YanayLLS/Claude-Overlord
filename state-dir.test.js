// Run: node state-dir.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { migrateLegacy } = require('./state-dir');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'state-dir-test-'));
const mk = (name, files) => {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(d, f), body);
  return d;
};

// happy path: config copied, logs left behind, originals untouched
const legacy = mk('legacy', {
  'overlord-state.json': '{"agents":[1]}',
  'overlord-state.json.bak': '{"agents":[]}',
  'overlord-settings.json': '{"zoom":90}',
  'accounts.json': '{}',
  'overlord.log': 'noise',
});
const fresh = path.join(root, 'fresh');
assert.strictEqual(migrateLegacy(legacy, fresh), 4);
assert.strictEqual(fs.readFileSync(path.join(fresh, 'overlord-state.json'), 'utf8'), '{"agents":[1]}');
assert.strictEqual(fs.readFileSync(path.join(fresh, 'overlord-settings.json'), 'utf8'), '{"zoom":90}');
assert.ok(!fs.existsSync(path.join(fresh, 'overlord.log')), 'logs are not carried across');
assert.ok(fs.existsSync(path.join(legacy, 'overlord-state.json')), 'copy, not move — rollback still works');

// idempotent: a second run must not overwrite state the new dir has since written
fs.writeFileSync(path.join(fresh, 'overlord-state.json'), '{"agents":[1,2,3]}');
assert.strictEqual(migrateLegacy(legacy, fresh), 0);
assert.strictEqual(fs.readFileSync(path.join(fresh, 'overlord-state.json'), 'utf8'), '{"agents":[1,2,3]}');

// nothing to migrate from
assert.strictEqual(migrateLegacy(path.join(root, 'missing'), path.join(root, 'dest')), 0);
assert.ok(!fs.existsSync(path.join(root, 'dest')), 'no empty dir created when there is nothing to copy');

// same dir in and out is a no-op, not a self-copy
assert.strictEqual(migrateLegacy(legacy, legacy), 0);

// a legacy dir with no state file still hands over whatever config it has
const partial = mk('partial', { 'accounts.json': '{"a":1}' });
const dest2 = path.join(root, 'dest2');
assert.strictEqual(migrateLegacy(partial, dest2), 1);
assert.strictEqual(fs.readFileSync(path.join(dest2, 'accounts.json'), 'utf8'), '{"a":1}');

fs.rmSync(root, { recursive: true, force: true });
console.log('state-dir: all tests passed');
