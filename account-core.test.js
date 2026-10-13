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
