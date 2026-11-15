const test = require('node:test');
const assert = require('node:assert');
const { featureEnv, startOrder } = require('./feature-env');

const fe = { path: 'W/frontline.io-web/F', repo: 'C:/Work/frontline.io-web', feature: 'F' };
const ds = { path: 'W/Designs/F', repo: 'C:\\Work\\Designs', feature: 'F' };
const other = { path: 'W/frontline.io-web/G', repo: 'C:/Work/frontline.io-web', feature: 'G' };
const worktrees = [fe, ds, other];
const urls = { 'W/frontline.io-web/F': 'https://lvh.me:5170', 'W/frontline.io-web/G': 'https://lvh.me:5190' };
const running = (p) => urls[p] || null;
const reads = (repo, v) => /Designs/.test(repo) && v === 'FL_BACK_URL';

test('a feature front-end gets its own feature\'s backend, not another feature\'s', () => {
  const { env, links } = featureEnv({ entry: ds, worktrees, running, reads, base: {} });
  assert.strictEqual(env.FL_BACK_URL, 'https://lvh.me:5170');
  assert.deepStrictEqual(links, [{ name: 'FL_BACK_URL', repo: 'frontline.io-web', url: 'https://lvh.me:5170' }]);
  assert.strictEqual(env.OVERLORD_FEATURE_FRONTLINE_IO_WEB_URL, 'https://lvh.me:5170');
});

test('nothing is wired when the backend is not running, the repo does not read the var, or the user set it', () => {
  assert.strictEqual(featureEnv({ entry: ds, worktrees, running: () => null, reads, base: {} }).env.FL_BACK_URL, undefined);
  assert.strictEqual(featureEnv({ entry: ds, worktrees, running, reads: () => false, base: {} }).env.FL_BACK_URL, undefined);
  assert.strictEqual(featureEnv({ entry: ds, worktrees, running, reads, base: { FL_BACK_URL: 'https://mine' } }).env.FL_BACK_URL, undefined);
  assert.deepStrictEqual(featureEnv({ entry: { path: 'x', repo: 'C:/Work/Designs' }, worktrees, running, reads, base: {} }), { env: {}, links: [] });
});

test('Start all servers starts the backends others link to first', () => {
  assert.deepStrictEqual(startOrder([ds, fe]).map(w => w.path), [fe.path, ds.path]);
});
