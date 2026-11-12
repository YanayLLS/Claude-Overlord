// Saved logins for the agents' browser: a username and password typed into any agent's page (by you or an agent)
// is kept per site, encrypted with the OS (safeStorage), and filled in and submitted on that site's login page
// the next time any agent lands on it - so no agent asks you to log in again. Passwords never reach an agent:
// they go from the page to this store and back into the page.
const fs = require('fs');

const MARK = '__ovl_login__';

// Injected into every page: reports the username + password when a login form is sent (submit, Enter or a button
// click). A username typed on an earlier step (email first, password next) is held in sessionStorage for the next one.
const CAPTURE_JS = `(() => { if (window.__ovlLogin) return; window.__ovlLogin = 1;
  const userSel = 'input[type=email],input[autocomplete=username],input[name*=user i],input[name*=email i],input[id*=user i],input[id*=email i]';
  const remember = () => { for (const i of document.querySelectorAll(userSel)) if (i.value) try { sessionStorage.setItem('__ovlUser', i.value); } catch {} };
  const report = () => { remember();
    const pws = [...document.querySelectorAll('input[type=password]')].filter(i => i.value); if (pws.length !== 1) return; // 2+: a change-password form
    let user = ''; try { user = sessionStorage.getItem('__ovlUser') || ''; } catch {}
    console.debug('${MARK}' + JSON.stringify({ u: user, p: pws[0].value })); };
  document.addEventListener('submit', report, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter') report(); }, true);
  document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('button,[type=submit],[role=button]')) report(); }, true);
})()`;

// Fills the visible login form and sends it. Only on a page with exactly one password field (a change-password
// page has two), or a username-only first step on a page whose address says it is a login.
const fillJs = (user, pass) => `(async (u, p) => {
  const vis = (e) => e && e.offsetParent !== null && !e.disabled && !e.readOnly;
  const set = (el, v) => { const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; el.focus(); s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
  const pws = [...document.querySelectorAll('input[type=password]')].filter(vis);
  if (pws.length > 1) return 'skip';
  const pw = pws[0];
  const users = [...document.querySelectorAll('input[type=email],input[autocomplete=username],input[type=text],input:not([type])')].filter(vis);
  const user = pw ? users.filter(i => i.compareDocumentPosition(pw) & 4).pop() : users.find(i => i.type === 'email' || /user|email|login/i.test(i.name + i.id + i.autocomplete));
  if (!pw && !(user && /login|signin|sign-in|auth|account/i.test(location.href))) return 'none';
  if (pw && pw.value) return 'filled';
  if (user && !user.value && u) set(user, u);
  if (pw) set(pw, p);
  const scope = (pw || user).form || document;
  const btn = scope.querySelector('button[type=submit],input[type=submit]') || [...scope.querySelectorAll('button,[role=button]')].filter(vis).find(b => /log ?in|sign ?in|continue|next|submit/i.test(b.textContent));
  if (btn) btn.click(); else if ((pw || user).form) (pw || user).form.requestSubmit();
  return pw ? 'submitted' : 'user';
})(${JSON.stringify(user)}, ${JSON.stringify(pass)})`;

// Is there an empty login form to fill? (A form you're typing into, or one already filled, is left alone.)
const PROBE_JS = `(() => { const vis = (e) => e.offsetParent !== null && !e.disabled;
  const pws = [...document.querySelectorAll('input[type=password]')].filter(vis);
  if (pws.length) return pws.length === 1 && !pws[0].value && document.activeElement !== pws[0];
  return /login|signin|sign-in|auth|account/i.test(location.href) && [...document.querySelectorAll('input[type=email],input[autocomplete=username]')].some(i => vis(i) && !i.value && document.activeElement !== i);
})()`;

function createLogins({ file, safeStorage, log = () => {}, now = Date.now }) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch {}
  const tries = new Map(); // origin -> recent fill times
  const canCrypt = () => { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } };

  function save(origin, user, pass) {
    if (!origin || !pass || !canCrypt()) return false;
    const cur = data[origin];
    const u = user || (cur && cur.u) || '';
    const p = safeStorage.encryptString(pass).toString('base64');
    if (cur && cur.u === u && get(origin)?.pass === pass) return false;
    data[origin] = { u, p, at: now() };
    try { fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 }); } catch {}
    log(`browser: saved the login for ${origin}`);
    return true;
  }
  function get(origin) {
    const e = data[origin]; if (!e || !canCrypt()) return null;
    try { return { user: e.u, pass: safeStorage.decryptString(Buffer.from(e.p, 'base64')) }; } catch { return null; }
  }
  // At most 3 fills per site in 2 minutes: a saved password that no longer works must not loop.
  function mayFill(origin) {
    const t = now(), recent = (tries.get(origin) || []).filter(x => t - x < 120000);
    if (recent.length >= 3 || (recent.length && t - recent[recent.length - 1] < 8000)) return false;
    tries.set(origin, [...recent, t]); return true;
  }
  return { save, get, mayFill, has: (o) => !!data[o] };
}

// Hooks one view: captures logins from its pages and fills saved ones on login pages.
function wireLogins(webContents, logins, log = () => {}) {
  const origin = () => { try { return new URL(webContents.getURL()).origin; } catch { return ''; } };
  webContents.on('console-message', (...args) => {
    const msg = typeof args[2] === 'string' ? args[2] : (args[0] && args[0].message) || '';
    if (!msg.startsWith(MARK)) return;
    try { const { u, p } = JSON.parse(msg.slice(MARK.length)); logins.save(origin(), u, p); } catch {}
  });
  const onPage = () => {
    webContents.executeJavaScript(CAPTURE_JS, true).catch(() => {});
    setTimeout(async () => {
      const o = origin(), saved = /^https?:/.test(o) && logins.get(o);
      if (!saved || webContents.isDestroyed()) return;
      // check first (no side effects), count a try only when there is a form to fill
      const probe = await webContents.executeJavaScript(PROBE_JS, true).catch(() => false);
      if (!probe || !logins.mayFill(o)) return;
      const r = await webContents.executeJavaScript(fillJs(saved.user, saved.pass), true).catch(() => 'error');
      if (r === 'submitted' || r === 'user') log(`browser: filled the saved login on ${o}`);
    }, 700); // an app draws its login form after load
  };
  webContents.on('did-finish-load', onPage);
  webContents.on('did-navigate-in-page', onPage);
}

module.exports = { createLogins, wireLogins, fillJs, CAPTURE_JS, MARK };
