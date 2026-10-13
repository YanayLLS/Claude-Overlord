// An agent pinned to another saved Claude login runs on that login's token (CLAUDE_CODE_OAUTH_TOKEN),
// so Overlord's own login — and every unpinned agent — stays on the main account.
// - agentToken: a 1-year inference-only token, the same browser flow as `claude setup-token`. An agent
//   can't refresh an env token itself, and refreshes are capped at 8h, so agents need the long one.
// - usageToken: an 8h token minted from the saved refresh token, to read that login's usage.
const https = require('https');
const crypto = require('crypto');

const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
const SUCCESS_URL = 'https://platform.claude.com/oauth/code/success?app=claude-code';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'; // Claude Code's public OAuth client
const USAGE_SCOPES = 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
// A refresh must ask for exactly the scopes the login was granted, or the server says invalid_scope.
const refreshScope = (oauth) => (oauth && oauth.scopes && oauth.scopes.length ? oauth.scopes.join(' ') : USAGE_SCOPES);
const YEAR_S = 31536000;
const MIN_LEFT_MS = 3600000; // re-mint an hour early so a fresh spawn never gets a dying token

// The token's access string, or null when it's missing or about to expire.
function validToken(t, now) {
  return t && t.accessToken && t.expiresAt - now > MIN_LEFT_MS ? t.accessToken : null;
}
const toToken = (resp, now) => ({ accessToken: resp.access_token, expiresAt: now + resp.expires_in * 1000 });

// Fold a refresh reply into the saved account. The refresh token rotates, so the new one
// must be kept or the next switch to this account would need a browser login.
function applyRefresh(acct, resp, now) {
  acct.usageToken = toToken(resp, now);
  if (resp.refresh_token && acct.credentials && acct.credentials.claudeAiOauth) acct.credentials.claudeAiOauth.refreshToken = resp.refresh_token;
  return acct.usageToken.accessToken;
}

function postToken(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(TOKEN_URL, { method: 'POST', timeout: 30000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let out = '';
      res.on('data', c => { out += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`token endpoint ${res.statusCode}: ${out.slice(0, 200)}`));
        try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('token endpoint timed out')));
    req.end(data);
  });
}

// Mutates acct; the caller saves accounts.json.
async function mintUsageToken(acct, now = Date.now()) {
  const oauth = acct && acct.credentials && acct.credentials.claudeAiOauth, refresh = oauth && oauth.refreshToken;
  if (!refresh) throw new Error('no saved refresh token — switch to this account once');
  return applyRefresh(acct, await postToken({ grant_type: 'refresh_token', refresh_token: refresh, client_id: CLIENT_ID, scope: refreshScope(oauth) }), now);
}

// PKCE pieces for the browser login; the caller serves http://localhost:<port>/callback.
function newLogin(port, email) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const state = crypto.randomBytes(32).toString('base64url');
  const redirect = `http://localhost:${port}/callback`;
  const q = new URLSearchParams({ code: 'true', client_id: CLIENT_ID, response_type: 'code', redirect_uri: redirect, scope: 'user:inference',
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state });
  if (email) q.append('login_hint', email); // preselects the account on the sign-in page
  return { url: `${AUTHORIZE_URL}?${q}`, verifier, state, redirect };
}

async function exchangeCode(login, code, now = Date.now()) {
  const resp = await postToken({ grant_type: 'authorization_code', code, redirect_uri: login.redirect, client_id: CLIENT_ID, code_verifier: login.verifier, state: login.state, expires_in: YEAR_S });
  return toToken(resp, now);
}

module.exports = { validToken, refreshScope, applyRefresh, mintUsageToken, newLogin, exchangeCode, SUCCESS_URL };
