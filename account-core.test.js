// Run: node account-core.test.js
const assert = require('assert');
const { validToken, applyRefresh, newLogin, refreshScope } = require('./account-core');

const H = 3600000;
assert.strictEqual(validToken(null, 0), null);
assert.strictEqual(validToken({ accessToken: 'a', expiresAt: 2 * H }, 0), 'a');
assert.strictEqual(validToken({ accessToken: 'a', expiresAt: H - 1 }, 0), null); // dies within the hour: re-mint

const acct = { credentials: { claudeAiOauth: { refreshToken: 'old' } } };
assert.strictEqual(applyRefresh(acct, { access_token: 'new', refresh_token: 'rot', expires_in: 100 }, 1000), 'new');
assert.deepStrictEqual(acct.usageToken, { accessToken: 'new', expiresAt: 101000 });
assert.strictEqual(acct.credentials.claudeAiOauth.refreshToken, 'rot'); // rotated token kept
applyRefresh(acct, { access_token: 'n2', expires_in: 1 }, 0);
assert.strictEqual(acct.credentials.claudeAiOauth.refreshToken, 'rot'); // no rotation: old one stays

const l = newLogin(5555, 'a@b.c'), u = new URL(l.url);
assert.strictEqual(u.searchParams.get('redirect_uri'), 'http://localhost:5555/callback');
assert.strictEqual(u.searchParams.get('scope'), 'user:inference');
assert.strictEqual(u.searchParams.get('login_hint'), 'a@b.c');
assert.strictEqual(u.searchParams.get('state'), l.state);
assert.ok(!newLogin(1).url.includes('login_hint'));
console.log('account-core ok');

// Refresh asks for the login's own scopes; the server rejects any other set.
assert.strictEqual(refreshScope({ scopes: ['user:inference', 'user:plugins'] }), 'user:inference user:plugins');
assert.ok(refreshScope({}).includes('user:inference'));

// A refresh also freshens the saved login's access token, so switching to it works without a re-login.
{
  const a = { credentials: { claudeAiOauth: { accessToken: 'stale', expiresAt: 0, refreshToken: 'r' } } };
  applyRefresh(a, { access_token: 'fresh', expires_in: 10 }, 0);
  assert.strictEqual(a.credentials.claudeAiOauth.accessToken, 'fresh');
  assert.strictEqual(a.credentials.claudeAiOauth.expiresAt, 10000);
}

// loginMove: when an agent on the main login restarts onto a newly switched login, and what it's told.
{
  const { loginMove } = require('./account-core');
  const bg = new Set(['x']);
  assert.strictEqual(loginMove({ _loginMove: false, isWaiting: true }), null);
  assert.deepStrictEqual(loginMove({ _loginMove: true, isWaiting: true, bgTasks: new Set() }), { nudge: null }); // idle, nothing running: quiet
  assert.strictEqual(loginMove({ _loginMove: true, isWaiting: false }), null); // mid-turn: wait
  assert.strictEqual(loginMove({ _loginMove: true, isWaiting: true, bgTasks: bg }), null); // background work: wait for it
  assert.deepStrictEqual(loginMove({ _loginMove: true, _limitHit: true }), { nudge: 'limit' });
  assert.deepStrictEqual(loginMove({ _loginMove: true, _limitHit: true, bgTasks: bg }), { nudge: 'limit+bg' }); // stopped anyway: go, say what died
}
