# PR Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Poll watched GitHub repos via the `gh` CLI and show open non-draft PRs as a top-bar badge with a dropdown; fire a desktop notification for each newly-seen PR.

**Architecture:** All polling lives in `main.js`. A timer runs `gh pr list` per configured repo, aggregates non-draft PRs, diffs their keys against a persisted seen-set to fire one notification per new PR, and pushes the full list to the renderer over the existing `send()` IPC channel. The renderer renders a dedicated `#pr-badge` element (separate from `#headerBadges`, which `render()` wipes) with a click-to-open dropdown.

**Tech Stack:** Electron, Node `child_process.execFile`, `gh` CLI, vanilla JS renderer.

## Global Constraints

- Versioning: bump `package.json` version (patch for fixes, minor for features) in the same commit pushed to master. This feature → minor bump.
- gh CLI only — no PAT, no OAuth.
- Quiet errors: log gh failures once, never per-tick; never fire notifications on error.

---

### Task 1: PR polling engine in main.js

**Files:**
- Modify: `main.js` (add state defaults, poll module, IPC cases, timer arm)

**Interfaces:**
- Produces: `send({ type: 'prList', prs, error })` to renderer where `prs` is
  `[{ key, repo, number, title, url, author }]` and `error` is a string or null.
- Consumes IPC: `{ type: 'savePrSettings', prSettings: { enabled, repos, intervalSec } }`.
- Reuses existing IPC: `{ type: 'openUrl', url }` (already handled at main.js:2030).

- [ ] **Step 1: Add settings defaults + self-checkable diff helper**

In `main.js`, near the `settings` default (main.js:725), the default object already
spreads from saved state. Add a pure helper above the poll code:

```js
// ── PR notifications ───────────────────────────────────
const PR_REPO_RE = /^[\w.-]+\/[\w.-]+$/;
function prKey(repo, number) { return `${repo}#${number}`; }
// Returns keys present now but not in the seen set.
function diffNewPRKeys(currentKeys, seenKeys) {
  const seen = new Set(seenKeys);
  return currentKeys.filter(k => !seen.has(k));
}
```

- [ ] **Step 2: Self-check the diff helper**

Create a throwaway check and run it:

```bash
node -e "
const PR_REPO_RE=/^[\w.-]+\/[\w.-]+$/;
function diffNewPRKeys(cur,seen){const s=new Set(seen);return cur.filter(k=>!s.has(k));}
const a=JSON.stringify(diffNewPRKeys(['o/r#1','o/r#2'],['o/r#1']))==='[\"o/r#2\"]';
const b=JSON.stringify(diffNewPRKeys(['o/r#1'],['o/r#1','o/r#3']))==='[]';
const c=PR_REPO_RE.test('owner/repo')&&!PR_REPO_RE.test('bad ; rm -rf');
if(a&&b&&c){console.log('PASS')}else{console.log('FAIL',a,b,c);process.exit(1)}
"
```

Expected: `PASS`

- [ ] **Step 3: Add the poll function**

```js
const { execFile } = require('child_process'); // if not already destructured; reuse existing require
let prTimer = null;
let prSeenSeeded = false;
let prGhErrorLogged = false;

function fetchRepoPRs(repo) {
  return new Promise((resolve) => {
    if (!PR_REPO_RE.test(repo)) return resolve([]);
    execFile('gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--json',
      'number,title,url,author,isDraft', '--limit', '100'],
      { timeout: 15000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve({ error: err.message });
        try {
          const rows = JSON.parse(stdout);
          resolve(rows.filter(r => !r.isDraft).map(r => ({
            key: prKey(repo, r.number), repo, number: r.number,
            title: r.title, url: r.url, author: (r.author && r.author.login) || '',
          })));
        } catch { resolve({ error: 'parse error' }); }
      });
  });
}

async function pollPRs() {
  const cfg = settings.prSettings;
  if (!cfg || !cfg.enabled || !Array.isArray(cfg.repos) || cfg.repos.length === 0) return;
  const results = await Promise.all(cfg.repos.map(fetchRepoPRs));
  const failed = results.find(r => r && r.error);
  if (failed) {
    if (!prGhErrorLogged) { console.log('[Overlord] PR poll failed:', failed.error); prGhErrorLogged = true; }
    send({ type: 'prList', prs: null, error: failed.error });
    return; // keep last known list in renderer; do not notify
  }
  prGhErrorLogged = false;
  const prs = results.flat();
  const currentKeys = prs.map(p => p.key);
  const seen = settings.prSeen || [];
  if (!prSeenSeeded && seen.length === 0) {
    // First run with no history: seed silently, no toasts for pre-existing PRs.
    prSeenSeeded = true;
  } else {
    for (const k of diffNewPRKeys(currentKeys, seen)) {
      const pr = prs.find(p => p.key === k);
      if (pr) notifyNewPR(pr);
    }
  }
  settings.prSeen = currentKeys;
  prSeenSeeded = true;
  saveState();
  send({ type: 'prList', prs, error: null });
}

function notifyNewPR(pr) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: `New PR · ${pr.repo}`, body: `#${pr.number} ${pr.title}`, silent: true });
  n.on('click', () => shell.openExternal(pr.url).catch(() => {}));
  n.show();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.flashFrame(true);
}

function armPrTimer() {
  if (prTimer) { clearInterval(prTimer); prTimer = null; }
  const cfg = settings.prSettings;
  if (!cfg || !cfg.enabled) return;
  const sec = Math.max(30, Number(cfg.intervalSec) || 60);
  pollPRs();
  prTimer = setInterval(pollPRs, sec * 1000);
}
```

- [ ] **Step 4: Add IPC case for saving PR settings**

In the `handleIpc` switch (near main.js:2030, alongside `openUrl`):

```js
case 'savePrSettings': {
  const p = msg.prSettings || {};
  settings.prSettings = {
    enabled: !!p.enabled,
    repos: Array.isArray(p.repos) ? p.repos.filter(r => PR_REPO_RE.test(r)) : [],
    intervalSec: Math.max(30, Number(p.intervalSec) || 60),
  };
  prSeenSeeded = false; // re-seed silently against the new repo set
  settings.prSeen = [];
  saveState();
  send({ type: 'settings', settings });
  armPrTimer();
  break;
}
```

- [ ] **Step 5: Arm the timer on startup**

Near the other startup `setInterval` blocks (main.js:2306), after settings are
restored, add:

```js
armPrTimer();
```

Place it after `restoreAgents`/settings merge so `settings.prSettings` is loaded.
If the existing startup arms intervals inside `app.whenReady`/window-created flow,
call `armPrTimer()` there instead — it must run after `settings` is merged from state.

- [ ] **Step 6: Sanity-run the app**

Run: `npm start`
Expected: app launches, no console errors referencing `pollPRs`/`armPrTimer`.
With no `prSettings` configured, `pollPRs` returns immediately (no gh calls).

- [ ] **Step 7: Commit**

```bash
git add main.js
git commit -m "feat: PR polling engine (gh CLI) with seen-diff + desktop notify"
```

---

### Task 2: Top-bar badge, dropdown, and settings UI

**Files:**
- Modify: `index.html` (header element, CSS, message handler, settings modal + handlers)

**Interfaces:**
- Consumes: `{ type: 'prList', prs, error }` from main.
- Produces: `api.send({ type: 'savePrSettings', prSettings })`, `api.send({ type: 'openUrl', url })`.

- [ ] **Step 1: Add the badge element + dropdown container to the header**

After `<div id="headerBadges"></div>` (index.html:847):

```html
<div id="pr-badge" style="display:none" onclick="togglePrDropdown(event)" title="Open PRs"></div>
<div id="pr-dropdown" style="display:none"></div>
```

- [ ] **Step 2: Add CSS**

In the `<style>` block (near `#headerBadges`, index.html:37):

```css
#pr-badge { cursor:pointer; font-size:11px; padding:2px 8px; border-radius:10px; background:var(--bg3); color:var(--text); border:1px solid var(--border); user-select:none; }
#pr-badge.err { color:#f38ba8; }
#pr-dropdown { position:absolute; top:40px; right:12px; z-index:50; background:var(--bg2,#1e1e2e); border:1px solid var(--border); border-radius:8px; min-width:280px; max-width:440px; max-height:60vh; overflow:auto; box-shadow:0 8px 24px rgba(0,0,0,.4); }
.pr-row { padding:8px 12px; cursor:pointer; border-bottom:1px solid var(--border); font-size:12px; }
.pr-row:last-child { border-bottom:none; }
.pr-row:hover { background:var(--bg3); }
.pr-row .pr-meta { color:var(--dim); font-size:11px; margin-top:2px; }
.pr-empty { padding:12px; color:var(--dim); font-size:12px; }
```

- [ ] **Step 3: Add renderer state + message handling**

Add a global near the top of the renderer script and a case in the `msg` switch
(alongside index.html:2661 `case 'settings'`):

```js
let prState = { prs: [], error: null };
```

```js
case 'prList':
  if (msg.error) { prState.error = msg.error; }
  else { prState.prs = msg.prs || []; prState.error = null; }
  renderPrBadge();
  break;
```

- [ ] **Step 4: Add badge + dropdown render/toggle functions**

```js
function renderPrBadge() {
  const b = document.getElementById('pr-badge');
  if (!b) return;
  if (prState.error) {
    b.style.display = ''; b.className = 'err'; b.textContent = '⬢ !';
    b.title = 'PR check failed — is gh installed and logged in? (' + prState.error + ')';
  } else if (prState.prs.length > 0) {
    b.style.display = ''; b.className = ''; b.textContent = '⬢ ' + prState.prs.length;
    b.title = prState.prs.length + ' open PR(s)';
  } else {
    b.style.display = 'none';
    document.getElementById('pr-dropdown').style.display = 'none';
  }
}

function togglePrDropdown(e) {
  if (e) e.stopPropagation();
  const d = document.getElementById('pr-dropdown');
  if (d.style.display === 'block') { d.style.display = 'none'; return; }
  if (prState.error) {
    d.innerHTML = '<div class="pr-empty">PR check failed. Ensure <b>gh</b> is installed and you are logged in (<code>gh auth login</code>).</div>';
  } else if (prState.prs.length === 0) {
    d.innerHTML = '<div class="pr-empty">No open PRs.</div>';
  } else {
    d.innerHTML = prState.prs.map(p =>
      `<div class="pr-row" onclick="openPr('${p.url.replace(/'/g, "\\'")}')">`
      + `<div>${escapeHtml(p.repo)} #${p.number} · ${escapeHtml(p.title)}</div>`
      + `<div class="pr-meta">@${escapeHtml(p.author)}</div></div>`).join('');
  }
  d.style.display = 'block';
}

function openPr(url) {
  api.send({ type: 'openUrl', url });
  document.getElementById('pr-dropdown').style.display = 'none';
}

document.addEventListener('click', (e) => {
  const d = document.getElementById('pr-dropdown');
  if (d && d.style.display === 'block' && !e.target.closest('#pr-dropdown') && e.target.id !== 'pr-badge') d.style.display = 'none';
});
```

Note: if `escapeHtml` does not already exist in the renderer, add:

```js
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
```

- [ ] **Step 5: Add settings modal controls**

In the settings modal (after the sound checkbox block, index.html ~915), add:

```html
<hr style="border:none;border-top:1px solid var(--border);margin:12px 0;">
<label class="settings-label">
  <input type="checkbox" id="chk-pr" onchange="onPrEnableChange(this.checked)" />
  <span>PR notifications (watch GitHub repos)</span>
</label>
<div class="settings-hint">Polls watched repos via the <code>gh</code> CLI for open PRs.</div>
<label class="settings-label" style="display:block;">
  <span>Watched repos (one <code>owner/repo</code> per line):</span>
  <textarea id="inp-pr-repos" rows="3" style="width:100%;font-family:inherit;font-size:12px;padding:4px 8px;color:var(--text);background:var(--bg3);border:1px solid var(--border);border-radius:4px;outline:none;margin-top:4px;" onchange="onPrSettingsChange()"></textarea>
</label>
<label class="settings-label">
  <span>Poll interval (seconds):</span>
  <input type="number" id="inp-pr-interval" min="30" step="10" value="60" style="width:80px;font-family:inherit;font-size:12px;padding:4px 8px;color:var(--text);background:var(--bg3);border:1px solid var(--border);border-radius:4px;outline:none;" onchange="onPrSettingsChange()" />
</label>
```

- [ ] **Step 6: Add settings handlers + apply on load**

```js
let prSettings = { enabled: false, repos: [], intervalSec: 60 };

function onPrEnableChange(val) { prSettings.enabled = val; onPrSettingsChange(); }
function onPrSettingsChange() {
  const repos = document.getElementById('inp-pr-repos').value.split('\n').map(s => s.trim()).filter(Boolean);
  const intervalSec = Math.max(30, Number(document.getElementById('inp-pr-interval').value) || 60);
  prSettings = { enabled: document.getElementById('chk-pr').checked, repos, intervalSec };
  api.send({ type: 'savePrSettings', prSettings });
}
```

In `applySettings(s)` (index.html:2946), add:

```js
if (s.prSettings) {
  prSettings = s.prSettings;
  const c = document.getElementById('chk-pr'); if (c) c.checked = !!prSettings.enabled;
  const r = document.getElementById('inp-pr-repos'); if (r) r.value = (prSettings.repos || []).join('\n');
  const i = document.getElementById('inp-pr-interval'); if (i) i.value = prSettings.intervalSec || 60;
}
```

- [ ] **Step 7: Manual test**

Run: `npm start`. Open Settings, enable PR notifications, add a real `owner/repo`
you have access to, set interval 30. Expected: within a few seconds the `⬡ N`
badge appears; clicking it lists PRs; clicking a row opens GitHub in the browser.
Open a new PR on that repo → desktop toast within one interval.

- [ ] **Step 8: Bump version + commit**

Bump `package.json` minor version (1.2.2 → 1.3.0).

```bash
git add index.html package.json
git commit -m "feat: PR notification top-bar badge, dropdown, and settings (v1.3.0)"
```

---

## Self-Review

- **Spec coverage:** poll via gh ✓ (T1.S3), configured repo list ✓ (T2.S5/6), non-draft filter ✓ (T1.S3), badge + count ✓ (T2.S4), click→browser ✓ (T2.S4 openPr → existing openUrl), desktop notif ✓ (T1 notifyNewPR), persist prSettings+prSeen ✓ (T1.S4), quiet errors ✓ (T1 prGhErrorLogged, badge `!`), silent first-seed ✓ (T1 prSeenSeeded). All covered.
- **Placeholder scan:** none.
- **Type consistency:** `prList` payload shape `{prs:[{key,repo,number,title,url,author}],error}` consistent across T1.S3 and T2.S3/S4. `savePrSettings.prSettings` shape `{enabled,repos,intervalSec}` consistent T1.S4 / T2.S6.
