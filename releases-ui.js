// Renderer side of the Releases board: footer badge, modal grid, cell detail,
// setup screen. Self-contained — index.html only loads this file, its stylesheet,
// and forwards { type: 'releases' } messages to releasesUi.onMsg.
(function () {
  let state = null, open = false, sel = null; // sel = [rowIdx, cellIdx]
  let rbOpen = null, rbSkip = new Set(); // History: the release whose Rollback confirm is open, repos unticked
  let apprOpen = false; // 👥 approvers panel
  let relOpen = false, relSel = new Set(), relShown = false; // Release picker: open?, chosen envs, already animated in?
  let tab = 'envs', envView = 'board', tlEnv = '', toToday = false; // tab: 'envs' | 'history'; envView: 'board' | 'timeline'; tlEnv: timeline env filter, '' = all
  let nowFold = false; // the release in flight sits open above the board; folded to its one-line strip on request

  const core = document.createElement('script');
  core.src = './releases-core.js';
  core.onload = () => { renderBadge(); if (open) render(); };
  document.head.appendChild(core);

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const age = (iso) => (window.ReleasesCore ? ReleasesCore.age(iso) : '');
  const link = (url, text, cls = 'rl-link') => `<a class="${cls}" data-url="${esc(url)}">${text}</a>`;

  const badge = document.createElement('div');
  badge.id = 'releases-badge';
  badge.title = "Releases — what's merged in each environment of each repo";
  badge.textContent = 'Releases';
  badge.onclick = (e) => { e.stopPropagation(); if (activeRelease(state)) { tab = 'envs'; envView = 'board'; nowFold = false; api.send({ type: 'releasesHistory' }); } show(true); };
  const chips = document.querySelector('.foot-chips');
  if (chips) chips.appendChild(badge);

  const overlay = document.createElement('div');
  overlay.id = 'rl-overlay';
  overlay.innerHTML = '<div id="rl-modal" role="dialog" aria-label="Releases"></div>';
  document.body.appendChild(overlay);
  const modal = overlay.firstChild;

  overlay.addEventListener('click', (e) => {
    // a click outside an open popover (release picker/results, approvers) closes just the popover
    if ((relOpen || apprOpen) && !e.target.closest('.rl-rel-pop, .rl-release, .rl-appr-btn')) {
      relOpen = false; apprOpen = false; render();
      return;
    }
    if (armed && !e.target.closest('[data-act="relMerge"], [data-act="histMerge"], [data-act="relCancel"], [data-act="rowMerge"], [data-act="rowHand"]')) { armed = null; render(); }
    if (e.target === overlay) return show(false);
    const a = e.target.closest('[data-url]');
    if (a) { e.stopPropagation(); return api.send({ type: 'openUrl', url: a.dataset.url }); }
    const act = e.target.closest('[data-act]');
    if (act) return actions[act.dataset.act](act);
    const cell = e.target.closest('.rl-cell');
    if (cell) {
      const k = [+cell.dataset.r, +cell.dataset.c];
      sel = sel && sel[0] === k[0] && sel[1] === k[1] ? null : k;
      render();
    }
  });
  // Esc closes the detail drawer first, then the modal
  document.addEventListener('keydown', (e) => {
    if (!open || e.key !== 'Escape') return;
    e.stopPropagation();
    if (apprOpen) { apprOpen = false; render(); } else if (relOpen) { relOpen = false; render(); } else if (sel) { sel = null; render(); } else show(false);
  }, true);

  const actions = {
    close: () => show(false),
    refresh: () => api.send({ type: 'releasesRefresh' }),
    editSource: () => { state = { ...(state || {}), editing: true }; render(); },
    saveSource: () => {
      const v = modal.querySelector('#rl-src-input').value;
      state = { ...(state || {}), editing: false };
      api.send({ type: 'releasesSetSource', source: v });
    },
    deselect: () => { sel = null; render(); },
    // opens (hover or click) with every env picked; slides in once, then re-renders keep it still
    releaseMenu: () => {
      if (relOpen || apprOpen) return;
      relOpen = true; relShown = false; relSkip = new Set(); relSeparate = false;
      // a finished run (nothing left open) is history, not what Release opens on: start fresh
      const run = state && state.releaseRun;
      if (run && !run.running && !run.rows.some(r => r.pr && !r.merged && !r.closed)) { state = { ...state, releaseRun: null }; api.send({ type: 'releasesClearRun' }); }
      // your last choice sticks (a hover-close + reopen must never re-tick an env you unticked);
      // only the very first time does it start with every env but alpha (a new key, so everyone starts there once)
      if (state && state.config) {
        const targets = ReleasesCore.releaseTargets(state.config);
        let saved = null;
        try { saved = JSON.parse(localStorage.getItem('rl-release-envs2') || 'null'); } catch {}
        relSel = new Set(Array.isArray(saved) ? saved.filter(e => targets.includes(e)) : targets.filter(e => e !== 'alpha')); // first time: everything but alpha
      }
      render();
    },
    releaseClose: () => { relOpen = false; render(); },
    apprMenu: () => { apprOpen = !apprOpen; relOpen = false; if (apprOpen) api.send({ type: 'releasesApprovers' }); render(); },
    apprAdd: () => {
      localBusy.set('appr', { label: 'Adding…', at: Date.now() });
      const inp = modal.querySelector('#rl-appr-add');
      const login = inp && inp.value.trim().replace(/^@/, '');
      if (login) api.send({ type: 'releasesApproversEdit', kind: 'add', login });
    },
    apprRemove: (el) => { markBusy(el, 'Removing…'); render(); api.send({ type: 'releasesApproversEdit', kind: 'remove', login: el.dataset.login }); },
    apprCreate: (el) => { markBusy(el, 'Creating the team…'); render(); api.send({ type: 'releasesApproversEdit', kind: 'create' }); },
    relSign: () => { api.send({ type: 'releasesSign' }); },
    // Release all merges to prod: the first click arms it (the button asks to confirm), a second within ARM_MS starts it
    relMerge: () => { if (armed !== 'run') return arm('run'); armed = null; startingAll(); api.send({ type: 'releasesMerge' }); render(); },
    relAllStop: (el) => { if (state && state.releaseAll) state = { ...state, releaseAll: { ...state.releaseAll, stopping: true } }; render(); api.send({ type: 'releasesReleaseAllStop' }); },
    relAllResume: (el) => { startingAll(); render(); api.send(el.dataset.id ? { type: 'releasesMergeRelease', id: el.dataset.id } : { type: 'releasesMerge' }); },
    // bell: add every repo of the release config the PRs panel isn't watching yet
    relWatch: () => {
      const missing = prsUnwatched();
      if (!missing || !missing.length) return;
      api.send({ type: 'savePrSettings', prSettings: { ...prSettings, repos: [...(prSettings.repos || []), ...missing] } });
      if (typeof showToast === 'function') showToast(`Watching ${missing.length} more repo${missing.length === 1 ? '' : 's'} in the PRs panel`);
      render();
    },
    relToggle: (el) => {
      const e = el.dataset.env; relSel.has(e) ? relSel.delete(e) : relSel.add(e);
      try { localStorage.setItem('rl-release-envs2', JSON.stringify([...relSel])); } catch {}
      render();
    },
    releaseGo: () => {
      if (!relSel.size) return;
      // runs in main without an agent; the panel turns into its live results. Unticked repos stay out
      const all = [...new Set(ReleasesCore.releasePlan(state.config, [...relSel]).prs.map(p => p.repo))];
      const repos = relSkip.size ? all.filter(r => !relSkip.has(r)) : null;
      if (repos && !repos.length) return;
      if (busyLabel('release')) return;
      localBusy.set('release', { label: 'Starting…', at: Date.now() }); render();
      api.send({ type: 'releasesRelease', envs: [...relSel], repos, of: all.length, separate: relSeparate });
    },
    relOnly: (el) => { relSkip = new Set(ReleasesCore.releasePlan(state.config, [...relSel]).prs.map(p => p.repo).filter(r => r !== el.dataset.repo)); render(); },
    // the Board cell's "Release just this": the picker set to this repo and env
    relJust: (el) => { relSel = new Set([el.dataset.env]); relSkip = new Set(ReleasesCore.releasePlan(state.config, [el.dataset.env]).prs.map(p => p.repo).filter(r => r !== el.dataset.repo)); relOpen = true; relShown = false; render(); },
    relSep: () => { relSeparate = !relSeparate; render(); },
    // a pending release's "Add repos": the picker, adding to it
    relAddTo: (el) => { relSel = new Set([el.dataset.env || 'prod']); relSkip = new Set(); relSeparate = false; relOpen = true; relShown = false; render(); },
    relRepo: (el) => { const r = el.dataset.repo; relSkip.has(r) ? relSkip.delete(r) : relSkip.add(r); render(); },
    relReposAll: (el) => { if (el.dataset.on === '1') relSkip = new Set(); else relSkip = new Set(ReleasesCore.releasePlan(state.config, [...relSel]).prs.map(p => p.repo)); render(); },
    // Fix on a blocked row: an agent for that repo only — leave the modal to land on it
    // one agent for every blocked row — leave the modal to land on it
    fixDeploy: (el) => { showToastSafe('Starting a fix agent for that deploy…'); api.send({ type: 'releasesFixDeploy', key: el.dataset.key }); show(false); },
    // el.dataset.i = one row's Fix; none = Fix all
    relFix: (el) => { const i = el && el.dataset.i != null ? +el.dataset.i : undefined; api.send({ type: 'releasesFix', i }); relOpen = false; show(false); },
    relNew: () => { api.send({ type: 'releasesClearRun' }); },
    tab: (el) => { tab = el.dataset.tab; sel = null; toToday = tab === 'envs' && envView === 'timeline'; api.send({ type: 'releasesHistory' }); render(); },
    nowFold: () => { nowFold = !nowFold; render(); },
    envView: (el) => { envView = el.dataset.v; sel = null; toToday = envView === 'timeline'; render(); },
    // history actions
    queueAll: (el) => { api.send({ type: 'releasesQueueAll', id: el.dataset.id }); },
    gotoRelease: () => { relOpen = false; tab = 'envs'; envView = 'board'; nowFold = false; api.send({ type: 'releasesHistory' }); render(); },
    rowToDev: (el) => { markBusy(el, 'Retargeting…'); render(); api.send({ type: 'releasesStrayFix', repo: el.dataset.repo, number: +el.dataset.n, how: 'retarget' }); },
    strayFix: (el) => { markBusy(el, el.dataset.how === 'close' ? 'Closing…' : 'Retargeting…'); render(); api.send({ type: 'releasesStrayFix', repo: el.dataset.repo, number: +el.dataset.n, how: el.dataset.how }); },
    histCard: (el) => { const id = el.dataset.id; openCards.has(id) ? openCards.delete(id) : openCards.add(id); render(); },
    histSort: (el) => { const k = el.dataset.k; histSort = { k, dir: histSort.k === k ? -histSort.dir : (k === 'release' || k === 'env' ? 1 : -1) }; try { localStorage.setItem('rl-hist-sort', JSON.stringify(histSort)); } catch {} render(); },
    histFilter: (el) => { histFilter = el.dataset.f; try { localStorage.setItem('rl-hist-filter', histFilter); } catch {} render(); },
    histChanges: (el) => { const k = el.dataset.key; openChanges.has(k) ? openChanges.delete(k) : openChanges.add(k); render(); },
    histRollback: (el) => { rbOpen = rbOpen === el.dataset.id ? null : el.dataset.id; rbSkip = new Set(); render(); },
    histRbRepo: (el) => { const r = el.dataset.repo; rbSkip.has(r) ? rbSkip.delete(r) : rbSkip.add(r); render(); },
    histRbGo: (el) => { markBusy(el, 'Opening rollback PRs…'); api.send({ type: 'releasesRollback', id: el.dataset.id, skip: [...rbSkip] }); rbOpen = null; render(); },
    // Cancel release: closes every open PR of it. Same two-click confirm as Release all
    // a repo of the release in flight: merge it now (two clicks), re-run its deploy, fix its checks, confirm a hand deploy
    busy: () => {},
    rowMerge: (el) => { const k = 'm:' + el.dataset.repo + '#' + el.dataset.n; if (armed !== k) return arm(k); armed = null; clearTimeout(armTimer); markBusy(el, 'Merging…'); render(); api.send({ type: 'releasesMergeOne', repo: el.dataset.repo, number: +el.dataset.n }); },
    rowRerun: (el) => { markBusy(el, 'Re-running…'); render(); api.send({ type: 'releasesRerunDeploy', repo: el.dataset.repo, number: +el.dataset.n }); },
    rowFix: (el) => { showToastSafe('Starting a fix agent…'); api.send({ type: 'releasesFixPr', repo: el.dataset.repo, number: +el.dataset.n }); show(false); },
    rowHand: (el) => { const k = 'h:' + el.dataset.repo; if (armed !== k) return arm(k); armed = null; clearTimeout(armTimer); markBusy(el, 'Recording…'); render(); api.send({ type: 'releasesConfirmHand', repo: el.dataset.repo, env: 'prod', label: el.dataset.label }); },
    relCancel: (el) => { const k = 'x:' + (el.dataset.id || 'run'); if (armed !== k) return arm(k); armed = null; if (state) state = { ...state, cancelling: el.dataset.id || 'run' }; api.send({ type: 'releasesCancel', id: el.dataset.id || null }); render(); },
    histMerge: (el) => { if (armed !== 'h:' + el.dataset.id) return arm('h:' + el.dataset.id); armed = null; startingAll(); api.send({ type: 'releasesMergeRelease', id: el.dataset.id }); render(); },
    histReload: () => { if (state) state = { ...state, history: null }; render(); api.send({ type: 'releasesHistory' }); },
    histImport: (el) => { markBusy(el, 'Importing past releases…'); render(); api.send({ type: 'releasesImport' }); },
    tlEnv: (el) => { tlEnv = el.dataset.env; render(); },
    cancelSource: () => { state = { ...(state || {}), editing: false }; render(); },
  };

  function show(on) {
    open = on;
    overlay.classList.toggle('open', on);
    api.send({ type: on ? 'releasesOpen' : 'releasesClose' });
    if (on) render();
  }

  // One cell = one env of one repo. Line 1: deploy dot, sha, age, and what's waiting for the
  // next env. Line 2: the commit title. Branch, author and deploy details live in tooltips.
  // Deploy status → the cell's colour (st-*) + a short label. The tooltip shows the same colour as a
  // small badge beside the label; the legend uses the same swatches.
  const DOT = { success: ['ok', 'Deployed'], failure: ['bad', 'Deploy failed'], partial: ['part', 'Deployed · a follow-up job failed'],
    running: ['run', 'Deploying now'], cancelled: ['off', 'Deploy cancelled'], never: ['off', 'Never deployed'] };
  function deployInfo(c) {
    // a pinned live commit beats everything else we could guess
    // manual = nothing deploys it on push (config says so, or its CI has never once worked)
    const manual = c.deploy === 'manual' || (c.run && c.run.state === 'dead');
    if (c.live && !c.live.error) {
      const how = manual ? 'Deployed by hand · ' : '';
      return { cls: manual && c.live.behind ? 'behind' : 'ok', manual, url: c.live.behind ? c.live.compareUrl : c.live.url,
        text: how + (c.live.behind ? `live: ${c.live.sha.slice(0, 7)} · ${c.live.behind} newer commit${c.live.behind === 1 ? '' : 's'} not deployed yet` : 'live: this commit') };
    }
    if (manual) return { cls: 'off', manual, text: 'Deployed by hand · no CI/CD, and nothing records which commit is live' };
    if (!c.deploy) return { cls: 'none', text: 'No deploy workflow' };
    if (!c.run) return { cls: 'off', text: 'Deploy status loading…' };
    const [cls, label] = DOT[c.run.state] || ['off', `Deploy ${c.run.state}`];
    // name what broke, e.g. "technical-pr-to-dev › Open (or reuse) the staging → dev technical PR"
    const why = (c.run.failed || []).map(f => f.job + (f.step ? ` › ${f.step}` : '')).join('; ');
    return { cls, manual: false, url: c.run.url, text: label + (c.run.date && c.run.state !== 'running' ? ` · ${age(c.run.date)} ago` : '') + (why ? ` · ${why}` : '') };
  }

  // PR number when the commit is a merge ("#933 fix: …"), else the short sha
  const refOf = (commit) => { const pr = (commit.title.match(/^#(\d+) /) || [])[1]; return pr ? '#' + pr : commit.sha.slice(0, 7); };

  function cellHtml(c, r, i) {
    if (!c) return '<div class="rl-empty"></div>';
    // no deployment of its own: say whose it runs instead of leaving a hole
    if (c.uses) {
      return `<div class="rl-uses" data-r="${r}" data-c="${i}">`
        + `uses <span class="rl-env" style="--hue:${ENV_HUE[c.uses.toLowerCase()] || 'var(--dim)'}">${esc(c.uses)}</span></div>`;
    }
    const d = deployInfo(c);
    // a manually deployed env with a pinned commit shows THAT commit, not the branch tip
    const shown = c.live && !c.live.error ? c.live : c.commit;
    let top;
    if (c.loading) top = '<span class="rl-age">loading…</span>';
    else if (c.missing) top = '<span class="rl-bad">branch missing</span>';
    else if (c.error) top = `<span class="rl-bad" title="${esc(c.error)}">! error</span>`;
    else top = `<span class="rl-sha">${esc(refOf(shown))}</span><span class="rl-age">${esc(age(shown.date))}</span>`;
    let next = '';
    if (c.live && c.live.behind) next = `<span class="rl-next">${link(c.live.compareUrl, `<b>${c.live.behind}</b> not live`)}</span>`;
    // one count per step out of this env — a fork (dev → alpha, dev → prod) shows both
    else next = (c.nexts || []).map((n, k) => {
      const lead = k ? ' rl-next-more' : '';
      if (n.loading) return `<span class="rl-next zero${lead}">… ${esc(n.to)}</span>`;
      if (n.error) return `<span class="rl-next rl-bad${lead}">? ${esc(n.to)}</span>`;
      if (!n.ahead) return `<span class="rl-next zero${lead}">✓ ${esc(n.to)}</span>`;
      return `<span class="rl-next${lead}">${link(n.url, `<b>${n.ahead}</b> → ${esc(n.to)}`)}</span>`;
    }).join('');
    const hand = d.manual ? '<svg class="rl-hand" viewBox="0 0 24 24" aria-label="manual deploy"><path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>' : '';
    const isSel = sel && sel[0] === r && sel[1] === i;
    return `<div class="rl-cell st-${d.cls}${isSel ? ' sel' : ''}" data-r="${r}" data-c="${i}"><div class="rl-top">${hand}${top}${next}</div></div>`;
  }

  const ENV_HUE = { dev: 'var(--accent)', alpha: 'var(--purple)', staging: 'var(--yellow)', prod: 'var(--green)', production: 'var(--green)' };
  const HUES = ['var(--accent)', 'var(--purple)', 'var(--cyan)', 'var(--yellow)', 'var(--green)'];

  const hueOf = (env, envs) => ENV_HUE[env.toLowerCase()] || HUES[envs.indexOf(env) % HUES.length];

  // Timeline tab, ClickUp-style: days run left→right, one lane per repo·env, each landing on that
  // env's branch is a pill at its moment. Same data the board's second pass already fetched —
  // no extra calls. Pills too close to their neighbour shrink to dots (hover for the rest).
  const DAY_MS = 864e5, DAY_W = 64, MAX_DAYS = 30, MIN_DAYS = 7;
  let tlMarks = []; // what each timeline dot stands for, by its data-i — read by the hover card

  // Hover card for a timeline dot: env + status badges and the time on top, the title, then
  // chips for PR, sha, branch and who. The app tooltip is text-only, so the dots bring their own.
  const tlTip = document.createElement('div');
  tlTip.id = 'rl-tlx-tip';
  document.body.appendChild(tlTip);
  const STATE_BADGE = { success: ['ok', 'Deployed'], failure: ['bad', 'Deploy failed'], partial: ['part', 'Deployed · side job failed'] };
  function tipHtml(e) {
    const [cls, label] = e.kind === 'merge' ? ['hand', '✋ Merged · deployed by hand'] : STATE_BADGE[e.state] || ['off', e.state];
    const when = new Date(e.date).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
    const pr = (e.title.match(/^#(\d+) /) || [])[1];
    return `<div class="tt-head"><span class="tt-env" style="--hue:${e.hue}">${esc(e.env)}</span><span class="tt-state ${cls}">${esc(label)}</span>`
      + `<span class="tt-when">${esc(when)}</span></div>`
      + `<div class="tt-repo">${esc(e.label)}</div>`
      + `<div class="tt-title">${esc(e.title.replace(/^#\d+ /, ''))}</div>`
      + '<div class="tt-chips">' + (pr ? `<span class="tt-chip">#${esc(pr)}</span>` : '')
      + `<span class="tt-chip mono">${esc(e.sha.slice(0, 7))}</span><span class="tt-chip">⎇ ${esc(e.branch)}</span>`
      + (e.actor ? `<span class="tt-chip">@${esc(e.actor)}</span>` : '') + '</div>'
      + `<div class="tt-foot">${e.kind === 'merge' ? 'Go-live time unknown · click to open the commit' : 'Click to open the run on GitHub'}</div>`;
  }
  // Hover card for a board cell: env + deploy-status badges and age, the commit, chips, then
  // what's waiting / what's live / what failed.
  const CELL_BADGE = { behind: ['part', 'Deployed · behind'], ok: ['ok', 'Deployed'], bad: ['bad', 'Deploy failed'], part: ['part', 'Deployed · side job failed'], run: ['part', 'Deploying now'] };
  function cellTipHtml(row, c) {
    const envBadge = `<span class="tt-env" style="--hue:${ENV_HUE[c.env.toLowerCase()] || 'var(--dim)'}">${esc(c.env)}</span>`;
    if (c.uses) {
      return `<div class="tt-head">${envBadge}<span class="tt-state off">uses ${esc(c.uses)}</span></div>`
        + `<div class="tt-repo">${esc(row.label)}</div>`
        + `<div class="tt-title">No deployment of its own — ${esc(c.env)} runs ${esc(c.uses)}'s.</div>`;
    }
    const d = deployInfo(c), shown = c.live && !c.live.error ? c.live : c.commit;
    const [cls, label] = CELL_BADGE[d.cls] || ['off', d.manual ? 'Live version unknown' : (c.run ? 'Deploy ' + c.run.state : 'No CI status')];
    const runDate = c.run && c.run.date && c.run.state !== 'dead' ? `deploy ${age(c.run.date)} ago` : shown ? `${age(shown.date)} ago` : '';
    let h = `<div class="tt-head">${envBadge}<span class="tt-state ${cls}">${esc(label)}</span>`
      + (d.manual ? '<span class="tt-state hand">✋ Manual</span>' : '') + `<span class="tt-when">${esc(runDate)}</span></div>`
      + `<div class="tt-repo">${esc(row.label)}</div>`;
    if (shown) {
      const pr = (shown.title.match(/^#(\d+) /) || [])[1];
      h += `<div class="tt-title">${esc(shown.title.replace(/^#\d+ /, ''))}</div>`
        + '<div class="tt-chips">' + (pr ? `<span class="tt-chip">#${esc(pr)}</span>` : '')
        + `<span class="tt-chip mono">${esc(shown.sha.slice(0, 7))}</span><span class="tt-chip">⎇ ${esc(c.branch)}</span>`
        + (c.commit && c.commit.author ? `<span class="tt-chip">@${esc(c.commit.author)}</span>` : '') + '</div>';
    } else if (c.error || c.missing) h += `<div class="tt-title">${esc(c.missing ? 'Branch ' + c.branch + ' is missing' : c.error)}</div>`;
    const lines = [];
    if (c.live && !c.live.error) lines.push(`<b>Live</b> ${esc(c.live.sha.slice(0, 7))}${c.live.behind ? ` · <b class="warn">${c.live.behind}</b> newer not deployed` : ' · up to date'}`);
    for (const n of c.nexts || []) {
      if (n.loading) continue;
      lines.push(n.error ? `→ ${esc(n.to)}: can't compare` : n.ahead ? `<b class="warn">${n.ahead}</b> waiting → ${esc(n.to)}` : `✓ nothing waiting for ${esc(n.to)}`);
    }
    const dead = c.run && c.run.state === 'dead';
    if (c.deploy && c.deploy !== 'manual') lines.push(dead ? `CI <span class="mono">${esc(c.deploy)}</span> has never succeeded — not how this env ships` : `CI <span class="mono">${esc(c.deploy)}</span>`);
    if (!dead) for (const f of (c.run && c.run.failed) || []) lines.push(`<span class="bad">✕ ${esc(f.job)}${f.step ? ' › ' + esc(f.step) : ''}</span>`);
    if (c.live && c.live.from) lines.push(`pinned in <span class="mono">${esc(c.live.from.split(':')[1] || c.live.from)}</span>`);
    if (c.live && c.live.confirmed) lines.push(`deployed by hand, confirmed by @${esc(c.live.confirmed.by || '?')} ${esc(age(c.live.confirmed.at))} ago`);
    if (lines.length) h += '<div class="tt-lines">' + lines.map(l => `<div>${l}</div>`).join('') + '</div>';
    return h + '<div class="tt-foot">Click for details</div>';
  }

  overlay.addEventListener('mouseover', (ev) => {
    const m = ev.target.closest && ev.target.closest('.rl-tlx-mark, .rl-cell[data-r], .rl-uses[data-r]');
    if (!m) return;
    let html = '';
    if (m.classList.contains('rl-tlx-mark')) { if (tlMarks[m.dataset.i]) html = tipHtml(tlMarks[m.dataset.i]); }
    else {
      const row = state && state.grid && state.grid.rows[m.dataset.r], c = row && row.cells && row.cells[m.dataset.c];
      if (c) html = cellTipHtml(row, c);
    }
    if (!html) return;
    tlTip.innerHTML = html;
    tlTip.classList.add('show');
    const r = m.getBoundingClientRect(), w = tlTip.offsetWidth, h = tlTip.offsetHeight;
    const x = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    const y = r.top - h - 10 >= 8 ? r.top - h - 10 : r.bottom + 10; // above the dot, or below when there's no room
    tlTip.style.left = x + 'px'; tlTip.style.top = y + 'px';
  });
  overlay.addEventListener('mouseout', (ev) => {
    const from = ev.target.closest && ev.target.closest('.rl-tlx-mark, .rl-cell[data-r], .rl-uses[data-r]');
    if (from && !(ev.relatedTarget && from.contains(ev.relatedTarget))) tlTip.classList.remove('show');
  });

  function timelineHtml(s) {
    tlMarks = [];
    const cfg = s.config, envs = cfg.envs, history = s.results && s.results.history;
    let h = '<div class="rl-tl-filter">'
      + [''].concat(envs).map(e => `<button data-act="tlEnv" data-env="${esc(e)}" class="${e === tlEnv ? 'on' : ''}">`
        + (e ? `<span class="rl-env" style="--hue:${hueOf(e, envs)}">${esc(e)}</span>` : 'All') + '</button>').join('') + '</div>';
    if (!history) return h + '<div class="rl-tl-empty">Loading history…</div>';
    const items = ReleasesCore.buildTimeline(cfg, history, tlEnv, s.results && s.results.deploys);
    if (!items.length) return h + '<div class="rl-tl-empty">Nothing landed here recently.</div>';

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const end = today.getTime() + DAY_MS;
    const oldest = Math.min(...items.map(e => Date.parse(e.date)));
    const days = Math.max(MIN_DAYS, Math.min(MAX_DAYS, Math.ceil((end - oldest) / DAY_MS)));
    const start = end - days * DAY_MS;
    const xOf = (t) => (t - start) / DAY_MS * DAY_W;

    h += `<div class="rl-tlx" style="--dayw:${DAY_W}px; --days:${days}">`;
    // axis: one cell per day, weekends shaded, today marked
    h += '<div class="rl-tlx-head"><div class="rl-tlx-corner"></div><div class="rl-tlx-axis">';
    for (let i = 0; i < days; i++) {
      const d = new Date(start + i * DAY_MS), wk = d.getDay() === 0 || d.getDay() === 6, isToday = d.getTime() === today.getTime();
      h += `<div class="rl-tlx-day${wk ? ' wk' : ''}${isToday ? ' today' : ''}"><b>${d.getDate()}</b>${esc(d.toLocaleDateString([], { weekday: 'short' }))}</div>`;
    }
    h += '</div></div>';

    const nowX = xOf(Date.now());
    let group = null;
    // one lane per repo; each release is a dot in its env's colour — env, PR, title, time on hover
    for (const r of cfg.repos) {
      if (!r.branches) continue;
      const label = r.label || r.repo.split('/')[1];
      const lane = items.filter(e => e.repo === r.repo && Date.parse(e.date) >= start)
        .sort((x, y) => Date.parse(x.date) - Date.parse(y.date));
      if (!lane.length) continue;
      if ((r.group || '') !== group) { group = r.group || ''; if (group) h += `<div class="rl-tlx-group">${esc(group)}</div>`; }
      h += `<div class="rl-tlx-row"><div class="rl-tlx-label" title="${esc(r.repo)}"><span class="rl-tlx-repo">${esc(label)}</span></div>`
        + `<div class="rl-tlx-track"><i class="rl-tlx-now" style="left:${nowX}px"></i>`;
      lane.forEach((e) => {
        const kind = e.kind === 'merge' ? ' merge' : e.state === 'failure' ? ' fail' : e.state === 'partial' ? ' part' : '';
        tlMarks.push({ ...e, hue: hueOf(e.env, envs) });
        h += `<a class="rl-tlx-mark${kind}" data-url="${esc(e.url)}" data-i="${tlMarks.length - 1}" style="left:${xOf(Date.parse(e.date))}px; --hue:${hueOf(e.env, envs)}"></a>`;
      });
      h += '</div></div>';
    }
    return h + '</div>';
  }

  const TL_LEGEND = '<div class="rl-legend"><span><i class="rl-tlx-key"></i>deployed</span><span><i class="rl-tlx-key fail"></i>deploy failed</span>'
    + '<span><i class="rl-tlx-key part"></i>deployed, side job failed</span><span><i class="rl-tlx-key merge"></i>merged, deployed by hand</span>'
    + '<span>colour = env</span></div>';

  function gridHtml(g) {
    let h = `<div class="rl-grid" style="grid-template-columns:max-content repeat(${g.envs.length}, minmax(108px, max-content))">`
      + '<div class="rl-colhead"></div>'
      + g.envs.map((e, i) => `<div class="rl-colhead"><span class="rl-env" style="--hue:${ENV_HUE[e.toLowerCase()] || HUES[i % HUES.length]}">${esc(e)}</span></div>`).join('');
    let group = null;
    g.rows.forEach((row, r) => {
      if (row.group !== group) { group = row.group; if (group) h += `<div class="rl-group">${esc(group)}</div>`; }
      h += `<div class="rl-label" title="${esc(row.repo)}">${link(`https://github.com/${row.repo}`, esc(row.label))}</div>`;
      h += row.note ? `<div class="rl-note">${esc(row.note)}</div>` : row.cells.map((c, i) => cellHtml(c, r, i)).join('');
    });
    return h + '</div>';
  }

  // Each item is one unbreakable unit; the row wraps between items, never inside one.
  const LEGEND = '<div class="rl-legend">'
    + '<span><i class="rl-sw st-ok"></i>deployed</span>'
    + '<span><i class="rl-sw st-bad"></i>deploy failed</span>'
    + '<span><i class="rl-sw st-part"></i>deployed, side job failed</span>'
    + '<span><i class="rl-sw st-run"></i>deploying</span>'
    + '<span><i class="rl-sw st-behind"></i>deployed by hand, behind</span>'
    + '<span><svg class="rl-hand" viewBox="0 0 24 24"><path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>manual deploy</span>'
    + '<span><span class="rl-next"><b>12</b> → prod</span>waiting to promote</span></div>';

  function detailHtml(grid) {
    const row = sel && grid.rows[sel[0]];
    const c = row && row.cells && row.cells[sel[1]];
    if (!c) return '';
    let h = `<div class="rl-detail"><button class="rl-x" data-act="deselect" title="Close"><svg class="ic" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg></button>`
      + `<h3>${esc(row.label)} · ${esc(c.env)} <span class="rl-mono">(${esc(c.branch)})</span></h3>`;
    const d = deployInfo(c);
    const fix = c.run && (c.run.state === 'failure' || c.run.state === 'partial') && c.run.runNumber
      ? ` <button class="rl-rr-fix" data-act="fixDeploy" data-key="${esc(row.repo + '|' + c.env)}" title="Agent reads the failed log and fixes it on a fix/ci branch">🔧 Fix</button>` : '';
    h += `<div class="rl-dep-line"><i class="rl-dot ${d.cls}"></i>${d.url ? link(d.url, esc(d.text)) : esc(d.text)}${fix}</div>`;
    if (c.live && !c.live.error) {
      h += `<div>Live: ${link(c.live.url, `<span class="rl-mono">${esc(c.live.sha.slice(0, 7))}</span> ${esc(c.live.title)}`)}`
        + ` — ${esc(age(c.live.date))} ago <span class="rl-mono">(pinned in ${esc(c.live.from)})</span></div>`;
    } else if (c.live && c.live.error) h += `<div class="rl-bad">Live commit unknown: ${esc(c.live.error)}</div>`;
    if (c.commit) {
      h += `<div>${link(c.commit.url, `<span class="rl-mono">${esc(c.commit.sha.slice(0, 7))}</span> ${esc(c.commit.title)}`)}`
        + ` — ${esc(c.commit.author)}, ${esc(age(c.commit.date))} ago</div>`;
    }
    const relTargets = s0().config ? ReleasesCore.releaseTargets(s0().config) : [];
    const canRel = (s0().approvers || {}).isApprover;
    for (const n of c.nexts || []) {
      if (n.loading || n.error) continue;
      if (!n.ahead) { h += `<div style="margin-top:6px">Nothing waiting for ${esc(n.to)}.</div>`; continue; }
      if (canRel && relTargets.includes(n.to)) h += `<button class="rl-hist-btn rl-just" data-act="relJust" data-repo="${esc(row.repo)}" data-env="${esc(n.to)}" title="Open the release picker set to just ${esc(row.label)} → ${esc(n.to)}">🚀 Release just ${esc(row.label)} → ${esc(n.to)}</button>`;
      h += `<div style="margin-top:6px">${n.ahead} commit${n.ahead === 1 ? '' : 's'} not yet in ${esc(n.to)} (newest first):</div><ul>`;
      if (!n.commits) h += '<li class="rl-age">loading…</li>';
      else for (const m of n.commits) h += `<li>${link(m.url, `<span class="rl-mono">${esc(m.sha.slice(0, 7))}</span> ${esc(m.title)}`)}</li>`;
      h += '</ul>';
      if (n.commits && n.ahead > n.commits.length) h += `<div>${link(n.url, `…and ${n.ahead - n.commits.length} more — compare on GitHub`)}</div>`;
    }
    return h + '</div>';
  }

  const EXAMPLE = `{
  "envs": ["dev", "staging", "prod"],
  "repos": [
    { "repo": "your-org/web",
      "branches": { "dev": "dev", "staging": "staging", "prod": "main" },
      "promote": ["dev", "staging", "prod"] },
    { "repo": "your-org/infra", "note": "Deployed by hand" }
  ]
}`;

  function setupHtml(s) {
    let h = '<div class="rl-setup">';
    if (s.error) h += `<div class="rl-bad">${esc(s.error)}</div>` + (typeof ghFixHtml === 'function' ? ghFixHtml(s.errorCode) : '');
    if (s.problems) h += '<div>The config has problems:</div><ul>' + s.problems.map(p => `<li>${esc(p)}</li>`).join('') + '</ul>';
    h += `<div style="margin-top:10px">Config source — <code>owner/repo:path/releases.json@branch</code> (shared with your team through GitHub) or an absolute path to a local <code>.json</code> file:</div>`
      + `<input id="rl-src-input" value="${esc(s.source)}" spellcheck="false">`
      + '<button data-act="saveSource">Save &amp; load</button>'
      + (s.grid ? ' <button data-act="cancelSource">Cancel</button>' : '')
      + '<div style="margin-top:10px">A config lists your environments in column order, then each repo with the branch it uses per environment. '
      + '<code>promote</code> is the path changes take; each step shows how many commits are waiting. <code>note</code> replaces the cells for repos that don\'t fit.</div>'
      + `<pre>${esc(EXAMPLE)}</pre></div>`;
    return h;
  }

  // First open, nothing cached yet: the board's shape, pulsing, instead of a bare "Loading…".
  function skeletonHtml() {
    const cols = 4, rows = 6;
    let h = `<div class="rl-grid rl-skel" style="grid-template-columns:max-content repeat(${cols}, 120px)"><div></div>`;
    for (let i = 0; i < cols; i++) h += '<div class="rl-colhead"><i style="width:40px"></i></div>';
    for (let r = 0; r < rows; r++) {
      h += '<div class="rl-label"><i style="width:90px"></i></div>';
      for (let i = 0; i < cols; i++) h += '<div class="rl-cell"><i style="width:70%"></i><i style="width:90%"></i></div>';
    }
    return h + '</div>';
  }

  const DONE = new Set(['deployed', 'merged-hand', 'hand-done']);
  const isHotfixRow = (r) => ((state && state.history && state.history.items) || []).some(m => m.kind === 'hotfix' && m.repos.includes(r));
  // Row actions for a repo of a release in flight (approvers): merge now / fix its checks / re-run its deploy
  function rowActs(r, need, notDeployed = []) {
    const st = state || {}, a = st.approvers || {};
    if (!a.isApprover || (st.releaseAll && st.releaseAll.running) || st.teamRun) return '';
    const d = `data-repo="${esc(r.repo)}" data-n="${esc(r.pr.number)}"`;
    if (need) {
      const k = 'm:' + r.repo + '#' + r.pr.number;
      const toDev = r.source && r.source !== r.target && isHotfixRow(r) ? `<button class="rl-row-btn" data-act="rowToDev" ${d} title="${esc(`Retarget to ${r.source} (it ships with the next release) and cancel this hotfix release${r.extraFromTarget ? `. ⚠ Its branch would bring ${r.extraFromTarget} commits ${r.source} doesn't have (branched off ${r.target}): close it and reopen from ${r.source} instead if that's not wanted` : ''}`)}">↪ To ${esc(r.source)}${r.extraFromTarget ? ` ⚠${r.extraFromTarget}` : ''}</button>` : '';
      return toDev + (r.health && r.health.checks === 'fail' ? `<button class="rl-row-btn" data-act="rowFix" ${d} title="Start an agent that gets this PR's checks green">🔧 Fix</button>` : '')
        + (armed === k ? `<button class="rl-row-btn armed${notDeployed.length ? ' risky' : ''}" data-act="rowMerge" ${d}${notDeployed.length ? ` title="${esc(`Earlier waves aren't deployed yet: ${notDeployed.join(', ')}. This one may depend on them.`)}"` : ''}>${notDeployed.length ? `⚠ Merge before ${esc(notDeployed.length === 1 ? notDeployed[0] : notDeployed.length + ' earlier repos')} deploy?` : 'Confirm: merge'}</button>`
          : `<button class="rl-row-btn" data-act="rowMerge" ${d} title="Merge just this one now (needs the release signed; GitHub's own rules apply)">Merge</button>`);
    }
    if (r.mergeSha && r.deploy && r.deploy.state === 'failure') return `<button class="rl-row-btn" data-act="rowRerun" ${d} title="Re-run the failed jobs of its deploy">↻ Re-run deploy</button>`;
    return '';
  }
  // a release whose ticket repo deployed 15+ min ago but no ClickUp ticket turned up: say so (the ticket step
  // can't fail the deploy, so nothing else would). Returns the explanation, or ''.
  function ticketLate(st, m) {
    const t = st.config && st.config.releaseTicket;
    if ((m.env || 'prod') !== 'prod' || m.kind === 'standalone') return ''; // tickets come from prod deploys only
    const r = t && m.repos.find(x => x.repo === t.repo && x.deploy && x.deploy.state === 'success');
    if (!r || Date.now() - Date.parse(r.deploy.at || 0) < 15 * 60 * 1000) return '';
    return `${r.label} deployed ${age(r.deploy.at)} ago but no ClickUp release ticket was found for it (its deploy's "Open the ClickUp release ticket" step probably failed: check that run). Or you're not connected to ClickUp in Overlord's Settings, so Overlord can't look it up.`;
  }
  // the pending release (if any) a repo's open release PR already belongs to
  const s0 = () => state || {};
  function pendingWith(st, repo) {
    const m = ((st.history && st.history.items) || []).find(x => x.status === 'pending' && x.repos.some(r => r.repo === repo && !r.mergeSha && !r.closed));
    return m ? m.id : null;
  }
  // PRs into prod opened outside the release flow: listed, with the way to put each right (approvers)
  function strayHtml(st) {
    const xs = st.strayPrs || [];
    if (!xs.length) return '';
    const ap = (st.approvers || {}).isApprover;
    return `<div class="rl-stray"><div class="rl-stray-head">⚠ ${xs.length} new PR${xs.length === 1 ? '' : 's'} into prod <span>Each becomes a release within ~2 min (a hotfix release if it isn't from ${esc(xs[0].source)}), so the signers see it. Or retarget it to ${esc(xs[0].source)} / close it now</span></div>`
      + xs.map(x => `<div class="rl-stray-row"><b>${esc(x.label)}</b>${link(x.url, '#' + x.number)}<span class="rl-stray-title" title="${esc(x.title)}">${esc(x.title)}</span>`
        + `<span class="rl-stray-br">${esc(x.head)} → ${esc(x.base)} · @${esc(x.author || '?')}</span>`
        + (ap ? `<button class="rl-row-btn show" data-act="strayFix" data-how="retarget" data-repo="${esc(x.repo)}" data-n="${esc(x.number)}" title="Change its base to ${esc(x.source)}">↪ To ${esc(x.source)}</button>`
          + `<button class="rl-row-btn show" data-act="strayFix" data-how="close" data-repo="${esc(x.repo)}" data-n="${esc(x.number)}">✕ Close</button>` : '') + '</div>').join('') + '</div>';
  }
  // the Board's pinned line for the release in flight
  function activeStrip(st) {
    const m = activeRelease(st);
    if (!m) return strayHtml(st);
    const nx = releaseNext(st, m);
    return `<div class="rl-active ${nx.tone}"><span class="rl-active-id">🚀 Release ${esc(m.id)}</span><span class="rl-active-phase">${esc(nx.phase)}</span>`
      + (nx.next ? `<span class="rl-active-next">next: ${esc(nx.next)}</span>` : '') + '<button class="rl-hist-btn" data-act="nowFold">Show release ▾</button></div>' + strayHtml(st);
  }
  // ── The release in flight: one summary every surface reads (footer badge, board strip, card) ──
  // in flight = open PRs, or merged in the last 2 days and still settling. An old or imported record stuck
  // at 'merged' (its deploy result was never recorded) isn't a release in flight
  const flight = (m) => m.status === 'pending' || (['merged', 'partial'].includes(m.status) && !m.imported && Date.now() - Date.parse(m.updatedAt || m.openedAt) < 2 * 86400e3);
  function activeRelease(st) {
    const items = (st && st.history && st.history.items) || [];
    return items.find(m => flight(m) && (m.env || 'prod') === 'prod') || items.find(flight) || null;
  }
  // where it stands and what has to happen next, in words: { phase, next, tone, act? }
  function releaseNext(st, m) {
    const ra = st.releaseAll, a = st.approvers || {}, me = String(a.me || '').toLowerCase();
    const team = (a.members || []).map(x => x.login);
    const open = m.repos.filter(r => !r.mergeSha && !r.closed);
    const relSigned = (m.signedBy || []).map(x => x.login);
    const signers = open.length ? team.filter(l => open.every(r => (r.signers || []).includes(l) || relSigned.includes(l))) : [];
    const signs = (m.env || 'prod') === 'prod';
    const failed = m.repos.filter(r => r.deploy && r.deploy.state === 'failure');
    const deploying = m.repos.filter(r => r.mergeSha && r.deploy && !['success', 'failure'].includes(r.deploy.state));
    if (ra && ra.running && ra.id === m.id) return { phase: ra.status === 'checking' ? 'starting Release all' : `wave ${ra.wave}/${ra.waves} ${ra.status === 'deploying' ? 'deploying' : ra.status === 'manual' ? 'waiting for a hand deploy' : 'merging'}`, next: ra.status === 'manual' ? 'deploy the hand step, then Deployed, continue' : 'Release all is on it', tone: 'run' };
    if (st.teamRun && st.teamRun.id === m.id) return { phase: `@${st.teamRun.by} is releasing (wave ${st.teamRun.wave}/${st.teamRun.waves})`, next: 'watch here', tone: 'run' };
    if (failed.length) return { phase: `${failed.map(r => r.label).join(', ')} deploy failed`, next: `↻ Re-run or 🔧 Fix ${failed.length === 1 ? 'its' : 'their'} deploy (row buttons)`, tone: 'bad' };
    if (open.length && signs && signers.length < 2) {
      const need = 2 - signers.length, iSigned = signers.some(l => l.toLowerCase() === me);
      const who = team.filter(l => !signers.includes(l)).map(l => '@' + l).join(' or ');
      return { phase: `${signers.length}/2 signed`, next: iSigned || !a.isApprover ? `${need} more signature${need === 1 ? '' : 's'} from ${who}` : 'sign it (✍ Sign)', tone: 'warn', act: !iSigned && a.isApprover ? 'sign' : null };
    }
    if (open.length) return { phase: signs ? 'signed, ready' : 'ready', next: 'press 🚀 Release all', tone: 'ok', act: 'release' };
    if (deploying.length) {
      const left = deploying.map(r => { const d = r.deploy; const el = d.startedAt ? Date.now() - Date.parse(d.startedAt) : 0; return d.typicalMs ? Math.max(0, d.typicalMs - el) : null; }).filter(x => x != null);
      return { phase: `deploying ${deploying.map(r => r.label).join(', ')}`, next: left.length ? `about ${Math.max(1, Math.round(Math.max(...left) / 60000))} min left` : 'wait for the deploys', tone: 'run' };
    }
    return { phase: m.status, next: '', tone: '' };
  }
  const fmtMin = (ms) => ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60000)}m`;
  // a repo's deploy as a pill: running = a link to the run with elapsed / usual time; done = the result (+ health)
  function deployPill(r, st) {
    const d = r.deploy;
    if (!d) return relItemHtml({ s: 'merged-hand' });
    if (d.state === 'success') {
      const h = st.health && st.health[r.repo + '|' + r.mergeSha];
      if (h && !h.ok) return `<a class="rl-item bad" data-url="${esc(h.url)}" title="Deployed, but its health check answered ${esc(h.status)}">deployed · unhealthy (${esc(h.status)})</a>`;
      return `<a class="rl-item ok"${d.url ? ` data-url="${esc(d.url)}"` : ''} title="${h ? 'Deployed and its health check answered OK' : 'Deploy run succeeded'}">${h ? 'live · healthy ✓' : 'deployed ✓'}</a>`;
    }
    if (d.state === 'failure') return `<a class="rl-item bad"${d.url ? ` data-url="${esc(d.url)}"` : ''} title="Open the failed deploy run">deploy failed ↗</a>`;
    const el = d.startedAt ? Date.now() - Date.parse(d.startedAt) : null;
    return `<a class="rl-item run"${d.runUrl ? ` data-url="${esc(d.runUrl)}"` : ''} title="Open the deploy run">deploying${el != null ? ` ${fmtMin(el)}${d.typicalMs ? ` / ~${fmtMin(d.typicalMs)}` : ''}` : '…'}${d.runUrl ? ' ↗' : ''}</a>`;
  }
  // A repo's status in a Release all (state.releaseAll.items[label]), as a short coloured note
  function relItemHtml(it) {
    if (!it) return '';
    if (it.s === 'held') return `<span class="rl-item warn" title="${esc(it.why || '')}">waiting${it.why ? ': ' + esc(it.why.length > 34 ? it.why.slice(0, 34) + '…' : it.why) : ''}</span>`;
    const t = { queued: ['', `wave ${it.wave}`], merging: ['run', 'merging…'], merged: ['ok', 'merged · deploying…'], 'merged-hand': ['ok', 'merged ✓'],
      deploying: ['run', 'deploying…'], deployed: ['ok', 'deployed ✓'], failed: ['bad', 'deploy failed'], held: ['warn', 'waiting'],
      hand: ['', `wave ${it.wave} · by hand`], 'hand-wait': ['warn', 'deploy by hand…'], 'hand-done': ['ok', 'deployed by hand ✓'] }[it.s] || ['', it.s];
    return `<span class="rl-item ${t[0]}">${esc(t[1])}</span>`;
  }
  // What the release run found for a pending PR (shared through the release record)
  function histHealth(h) {
    const bits = [];
    if (h.backMerge) bits.push(`<span class="${h.backMerge.conflict ? 'bad' : 'warn'}">back-merge ${link(h.backMerge.url, '#' + h.backMerge.number)} ${h.backMerge.conflict ? 'conflicts' : 'first'}</span>`);
    if (h.conflict) bits.push('<span class="bad">conflict</span>');
    if (h.checks === 'fail') bits.push('<span class="bad">checks failing</span>');
    if (h.dbschemas) bits.push(`<span class="bad" title="Uses dbschemas fields its build doesn't ship">dbschemas: ${esc(h.dbschemas.join(', '))}</span>`);
    if (h.error) bits.push(`<span class="bad" title="${esc(h.error)}">error</span>`);
    return bits.length ? `<span class="rl-hist-health">${bits.join(' · ')}</span>` : '';
  }
  // The one Release all button (release results + History): ready = what merges now (any env);
  // waiting = prod PRs held back until the release is signed 2/2. Nothing ready → locked, saying who still has to sign what.
  // signoff: { count, need, signers: [login], gaps: [{ login, missing: [{ label, older }] }] }
  // A Sign button; "Signing…" and not clickable while main is signing (s.signing)
  function signBtn(s, cls, label, title) {
    return s && s.signing ? `<button class="${cls} locked" aria-disabled="true">✍ Signing…</button>`
      : `<button class="${cls}" data-act="relSign"${title ? ` title="${esc(title)}"` : ''}>${label}</button>`;
  }
  // ✕ Cancel release (History card: its id; results popover: the run here). First click arms it.
  function cancelBtn(id, n, cls) {
    const k = 'x:' + (id || 'run');
    if (state && state.cancelling === (id || 'run')) return `<button class="${cls} locked" aria-disabled="true"><span class="rl-spin-dot"></span>Closing ${n} PR${n === 1 ? '' : 's'}…</button>`;
    return armed === k
      ? `<button class="${cls} armed-bad" data-act="relCancel"${id ? ` data-id="${esc(id)}"` : ''}>⚠ Confirm: close ${n} PR${n === 1 ? '' : 's'}</button>`
      : `<button class="${cls}" data-act="relCancel"${id ? ` data-id="${esc(id)}"` : ''} title="Call this release off: closes its ${n} open PR${n === 1 ? '' : 's'} (with a note). Merged ones stay merged">✕ Cancel release</button>`;
  }
  // optimistic: the progress line shows right on the confirming click; main's first update replaces it
  function startingAll() { if (state) state = { ...state, releaseAll: { running: true, status: 'checking', detail: 'starting', wave: 0, waves: 0, merged: [] } }; }
  let armed = null, armTimer = null;
  // ── Busy buttons: main marks a slow action busy (state.busy[key]); the click marks it locally at once to
  // bridge the round trip. After every render, a busy button shows a spinner + its label and is locked. ──
  const showToastSafe = (t) => { try { if (typeof showToast === 'function') showToast(t); } catch {} };
  const localBusy = new Map(); // key → { label, at }
  function keyOf(el) {
    const d = el.dataset, a = d.act;
    if (a === 'rowMerge') return `merge:${d.repo}#${d.n}`;
    if (a === 'rowRerun') return `rerun:${d.repo}#${d.n}`;
    if (a === 'rowToDev' || a === 'strayFix') return `stray:${d.repo}#${d.n}`;
    if (a === 'rowHand') return 'hand:' + d.repo;
    if (a === 'histRollback' || a === 'histRbGo') return 'rollback:' + d.id;
    if (a === 'histImport') return 'import';
    if (a === 'apprAdd' || a === 'apprRemove' || a === 'apprCreate') return 'appr';
    if (a === 'releaseGo') return 'release';
    if (a === 'relAllStop') return 'stop';
    return null;
  }
  function markBusy(el, label) { const k = keyOf(el); if (k) localBusy.set(k, { label, at: Date.now() }); }
  function busyLabel(k) {
    const st = state || {};
    if (st.busy && st.busy[k]) return st.busy[k];
    if (k === 'stop' && st.releaseAll && st.releaseAll.stopping && st.releaseAll.running) return 'Stopping…';
    const l = localBusy.get(k);
    if (l && Date.now() - l.at < 4000) return l.label; // until main's own busy flag arrives
    localBusy.delete(k);
    return null;
  }
  function applyBusy(root) {
    for (const el of root.querySelectorAll('[data-act]')) {
      const k = keyOf(el), label = k && busyLabel(k);
      if (!label) continue;
      el.innerHTML = '<span class="rl-spin-dot"></span>' + esc(label);
      el.classList.add('locked', 'show'); el.setAttribute('aria-disabled', 'true'); el.dataset.act = 'busy';
    }
  }
  let relSkip = new Set(); // release picker: repos left out (all in by default, every time it opens)
  let relSeparate = false; // release picker: start a release of its own instead of adding to the pending one
  const openChanges = new Set(); // History rows whose "N changes" list is open
  const openCards = new Set(); // finished releases opened (they show as one line by default)
  // what a person scans for: the env (or hotfix), the version, when — the id is for the tooltip
  function relTitle(m) {
    const env = m.env || 'prod';
    if (m.kind === 'rollback') return `↩ Rollback to ${m.rollbackOf}`;
    if (m.kind === 'hotfix' || m.kind === 'standalone') { const r = m.repos[0] || {}; return `${m.kind === 'hotfix' ? '🩹 Hotfix' : 'Standalone'} · ${r.label || ''}${r.pr ? ' #' + r.pr.number : ''}`; }
    return `${env[0].toUpperCase() + env.slice(1)} release${m.version ? ' · v' + m.version : ''}`;
  }
  function dayLabel(iso) {
    const d = new Date(iso), t = new Date(); const y = new Date(t); y.setDate(t.getDate() - 1);
    if (d.toDateString() === t.toDateString()) return 'Today';
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  }
  const hhmm = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  // one status per release: a dot and a word
  function relStatus(m) {
    const live = m.repos.filter(r => r.mergeSha), failed = live.filter(r => r.deploy && r.deploy.state === 'failure');
    if (m.status === 'cancelled') return ['off', 'cancelled'];
    if (m.status === 'abandoned') return ['off', 'closed'];
    if (failed.length) return ['bad', `${failed.length} deploy failed`];
    if (m.status === 'partial') return ['warn', 'partly shipped'];
    if (m.status === 'pending') return ['warn', 'pending'];
    if (m.status === 'merged') return ['run', 'deploying'];
    return ['ok', 'deployed'];
  }
  // finished releases are a table: sortable columns, one row each; click a row to open it
  let histSort = { k: 'when', dir: -1 }; try { histSort = JSON.parse(localStorage.getItem('rl-hist-sort')) || histSort; } catch {}
  const signersOf = (m) => [...new Set((m.signedBy || []).map(x => x.login).concat(m.repos.flatMap(r => r.signers || [])))];
  const unsignedOf = (m) => m.repos.some(r => r.unsigned) && !m.imported;
  const SORTS = {
    when: (m) => Date.parse(m.openedAt) || 0,
    release: (m) => relTitle(m).toLowerCase(),
    env: (m) => ['hotfix', 'standalone'].includes(m.kind) ? 'zz' + m.kind : (m.env || 'prod'),
    repos: (m) => m.repos.filter(r => r.mergeSha).length,
    signed: (m) => unsignedOf(m) ? -1 : signersOf(m).length,
    status: (m) => ['bad', 'warn', 'run', 'ok', 'off'].indexOf(relStatus(m)[0]),
  };
  const sortHist = (items) => { const f = SORTS[histSort.k] || SORTS.when; return items.sort((x, y) => { const a = f(x), b = f(y); return (a < b ? -1 : a > b ? 1 : 0) * histSort.dir || (SORTS.when(y) - SORTS.when(x)); }); };
  function histHead() {
    const th = (k, t, cls = '') => `<th class="${cls}${k && histSort.k === k ? ' on' : ''}"${k ? ` data-act="histSort" data-k="${k}" title="Sort by ${t.toLowerCase()}"` : ''}>${t}${k && histSort.k === k ? (histSort.dir < 0 ? ' ↓' : ' ↑') : ''}</th>`;
    return '<table class="rl-htab"><colgroup><col style="width:176px"><col><col style="width:84px"><col style="width:60px"><col style="width:200px"><col style="width:120px"><col style="width:80px"></colgroup><thead><tr>' + th('when', 'When') + th('release', 'Release') + th('env', 'Env') + th('repos', 'Repos', 'num')
      + th('signed', 'Signed by') + th('status', 'Status') + th('', 'Ticket') + '</tr></thead><tbody>';
  }
  // the Release cell: what it is at a glance — the version (or the hotfix PR) and which repos
  function relCell(m) {
    const names = esc(m.repos.map(r => r.label).join(', '));
    if (m.kind === 'rollback') return `<b>↩ to ${esc(m.rollbackOf)}</b>`;
    if (['hotfix', 'standalone'].includes(m.kind)) { const r = m.repos[0] || {}; return `<b>${m.kind === 'hotfix' ? '🩹 ' : ''}${esc(r.label || '')}${r.pr ? ' #' + r.pr.number : ''}</b>`; }
    return m.version ? `<b>v${esc(m.version)}</b> <span class="rl-dim">${names}</span>` : `<span>${names}</span>`;
  }
  const whenLabel = (iso) => { const d = dayLabel(iso); return `${d === 'Today' || d === 'Yesterday' ? d : d.replace(/,/g, '')} ${hhmm(iso)}`; };
  function relRow(st, m, signers, open) {
    const [tone, word] = relStatus(m), env = m.env || 'prod';
    const small = ['hotfix', 'standalone'].includes(m.kind), dead = tone === 'off';
    const shipped = m.repos.filter(r => r.mergeSha).length;
    const signed = unsignedOf(m)
      ? `<span class="rl-hrow-warn" title="Merged with fewer than 2 approvers' signatures${m.afterTheFact ? ', on GitHub (outside Overlord)' : ''}">⚠ unsigned${m.afterTheFact ? ' (GitHub)' : ''}</span>`
      : env === 'prod' && m.kind !== 'standalone' && signers.length ? signers.map(x => '@' + esc(x)).join(', ') : '<span class="rl-dim">—</span>';
    return `<tr class="rl-hrow${small ? ' small' : ''}${dead ? ' dead' : ''}${open ? ' open' : ''}" data-act="histCard" data-id="${esc(m.id)}" title="Release ${esc(m.id)} · click to ${open ? 'close' : 'open'}">`
      + `<td class="rl-hrow-time" title="${esc(m.openedAt)}"><i class="rl-caret">${open ? '▾' : '▸'}</i>${esc(whenLabel(m.openedAt))}</td>`
      + `<td class="rl-hrow-title" title="${esc(relTitle(m) + (small ? ' by @' + ((m.openedBy && m.openedBy.login) || '?') : '') + ' — ' + m.repos.map(r => r.label).join(', '))}">${relCell(m)}</td>`
      + `<td>${small ? `<span class="rl-dim">${m.kind}</span>` : `<span class="rl-env" style="--hue:${ENV_HUE[env.toLowerCase()] || 'var(--dim)'}">${esc(env)}</span>`}</td>`
      + `<td class="num" title="${esc(m.repos.map(r => r.label + (r.mergeSha ? '' : ' (not shipped)')).join(', '))}">${dead ? '<span class="rl-dim">—</span>' : shipped}</td>`
      + `<td class="rl-hrow-by">${signed}</td>`
      + `<td><span class="rl-hrow-st ${tone}"><i></i>${esc(word)}</span></td>`
      + `<td>${m.ticket ? `<a class="rl-hrow-ticket" data-url="${esc(m.ticket.url)}" title="${esc(m.ticket.name)}">ClickUp ↗</a>` : ''}</td>`
      + '</tr>';
  }
  let histFilter = 'all'; try { histFilter = localStorage.getItem('rl-hist-filter') || 'all'; } catch {}

  const ARM_MS = 6000;
  function arm(key) {
    armed = key; clearTimeout(armTimer);
    armTimer = setTimeout(() => { armed = null; render(); }, ARM_MS);
    render();
  }
  function releaseAllBtn(s, { ready, waiting, signoff, attrs, lockedCls, armKey, held = [] }) {
    // another release's Release all is running (one at a time): say so, and offer to queue this one behind it
    const runId = s.releaseAll && s.releaseAll.running ? s.releaseAll.id : undefined;
    const myId = (attrs.match(/data-id="([^"]+)"/) || [])[1];
    if (runId !== undefined && myId && runId !== myId && ready.length) {
      const other = ((s.history && s.history.items) || []).find(m => m.id === runId);
      const what = other ? `the ${other.env || 'prod'} release` : 'the running release';
      return s.releaseAllQueue === myId
        ? `<button class="${lockedCls} queued" data-act="queueAll" data-id="${esc(myId)}" title="Starts by itself when ${esc(what)} finishes cleanly. Click to unqueue">⏳ Queued after ${esc(what)}</button>`
        : `<button class="${lockedCls}" data-act="queueAll" data-id="${esc(myId)}" title="Release all runs one release at a time: ${esc(what)} is running now. Queue this one to start right after it">🚀 Release all · after ${esc(what)}</button>`;
    }
    if (s.releaseAll && s.releaseAll.running) return '';
    // one Release all across the team: someone else's is running
    if (s.teamRun) return `<button class="${lockedCls} locked" aria-disabled="true" title="${esc(`@${s.teamRun.by} is running Release all: wave ${s.teamRun.wave}/${s.teamRun.waves}, ${s.teamRun.status}${s.teamRun.detail ? ' (' + s.teamRun.detail + ')' : ''}${(s.teamRun.merged || []).length ? '\nmerged: ' + s.teamRun.merged.join(', ') : ''}`)}">🚀 Running on @${esc(s.teamRun.by)}'s Overlord · wave ${esc(s.teamRun.wave)}/${esc(s.teamRun.waves)}</button>`;
    const so = signoff || { count: 0, need: 2, signers: [], gaps: [] };
    const signedLine = `the prod release is signed ${so.count}/${so.need}${so.signers.length ? ' (' + so.signers.map(l => '@' + l).join(', ') + ')' : ''}`;
    const gapLines = (so.gaps || []).map(g => `\n@${g.login} still to sign: ${g.missing.map(x => x.label + (x.older ? ' (new commits)' : '')).join(', ')}`).join('');
    const pr = (r) => `• ${r.label} ${r.env || 'prod'}${r.pr ? ' #' + r.pr.number : ''}`;
    const heldLines = held.length ? `\n\nWaiting:\n${held.map(h => `• ${h.label}: ${h.why}`).join('\n')}` : '';
    if (!ready.length) return waiting.length
      ? `<button class="${lockedCls} locked" aria-disabled="true" title="${esc(`Can't merge yet: ${signedLine}.${gapLines}${heldLines}`)}">🔒 Release all · needs signatures</button>`
      : held.length ? `<button class="${lockedCls} locked" aria-disabled="true" title="${esc(`Nothing can merge yet:${heldLines}`)}">🔒 Release all · ${held.length} waiting</button>` : '';
    const byEnv = {};
    for (const r of ready) byEnv[r.env || 'prod'] = (byEnv[r.env || 'prod'] || 0) + 1;
    const tip = `${Object.entries(byEnv).map(([e, n]) => `${n} ${e}`).join(' + ')}. Merges now, in release order (services → iframes → frontend), waiting for each wave's deploys; stops on a failed deploy:\n`
      + ready.map(pr).join('\n') + (waiting.length ? `\n\nHeld back: ${signedLine}:\n${waiting.map(pr).join('\n')}${gapLines}` : '') + heldLines;
    if (armed === armKey) {
      const waves = s.config ? ReleasesCore.releaseWaves(s.config, ready).length : 1;
      return `<button ${attrs.replace('class="', 'class="armed ')} title="${esc(tip)}">⚠ Confirm: merge ${ready.length} PR${ready.length === 1 ? '' : 's'} in ${waves} wave${waves === 1 ? '' : 's'}</button>`;
    }
    return `<button ${attrs} title="${esc(tip)}">🚀 Release all · ${ready.length}</button>`;
  }

  // Release all's live progress: which wave, merging or waiting for deploys, the outcome; Stop.
  function releaseAllHtml(s) {
    const p = s.releaseAll;
    if (!p) return '';
    // a finished run's message goes stale once its release has nothing left open (merged since, by hand or on GitHub)
    const man = !p.running && p.id && ((s.history && s.history.items) || []).find(m => m.id === p.id);
    if (man && !man.repos.some(r => !r.mergeSha && !r.closed) && (p.status !== 'done' || /not merged/i.test(p.detail || '') || Date.now() - (p.at || 0) > 10 * 60 * 1000)) return '';
    const its = Object.values(p.items || {}).filter(x => x.s !== 'held');
    const doneN = its.filter(x => DONE.has(x.s)).length;
    const pct = its.length ? Math.round(doneN / its.length * 100) : 0;
    const what = p.running && p.status === 'checking' ? `Starting: ${esc(p.detail || '')}…`
      : p.running ? `Wave ${p.wave} of ${p.waves} · ${p.status === 'deploying' ? 'waiting for deploys' : p.status === 'manual' ? 'deploy by hand' : 'merging'}${p.detail ? `: <b>${esc(p.detail)}</b>` : ''}`
      : p.status === 'done' ? `Released ✓ <span class="rl-relall-sub">${esc(p.detail || '')}</span>`
      : p.status === 'partial' ? `Partly released <span class="rl-relall-sub">${esc(p.detail || '')}</span>`
      : p.status === 'interrupted' ? `Interrupted: Overlord closed at wave ${esc(p.wave)} of ${esc(p.waves)}`
      : `Stopped: ${p.url ? link(p.url, esc(p.detail || '')) : esc(p.detail || '')} <span class="rl-relall-sub">· next: ${/deploy failed/.test(p.detail || '') ? 'fix or ↻ re-run that deploy (its row), then 🚀 Release all again: it picks up where it stopped' : /signature/.test(p.detail || '') ? 'get the release signed, then 🚀 Release all' : 'fix what it names, then 🚀 Release all again: merged repos are skipped'}</span>`;
    const cls = p.running ? 'running' : p.status === 'done' ? 'ok' : 'bad'; // partial = amber, like stopped
    return `<div class="rl-relall ${cls}"><div class="rl-relall-top">`
      + `<span class="rl-relall-icon">${p.running ? (p.status === 'checking' ? '<span class="rl-spin-dot"></span>' : '🚀') : p.status === 'done' ? '✓' : '⏸'}</span>`
      + `<span class="rl-relall-what">${what}</span>`
      + (p.status === 'interrupted' ? `<button class="rl-hist-btn go" data-act="relAllResume" data-id="${esc(p.id || '')}" title="Picks up with what is still open: merged PRs are skipped, a deploy still running is waited on first">▶ Resume</button>` : '')
      + (p.running ? '<button class="rl-hist-btn" data-act="relAllStop" title="Stops before the next merge. What already merged stays merged">⏹ Stop</button>' : '')
      + '</div>'
      + (its.length ? `<div class="rl-relall-prog"><div class="rl-relall-bar"><i style="width:${pct}%"></i></div><span>${doneN} of ${its.length} done</span></div>` : '')
      + '</div>';
  }


  // ── History: every prod release from <org>/release-manifests, the pending one first ──
  const STATUS_CHIP = { pending: ['warn', 'pending'], merged: ['', 'merged · deploying'], deployed: ['ok', 'deployed ✓'],
    'deploy-failed': ['bad', 'deploy failed'], abandoned: ['', 'abandoned'], cancelled: ['', 'cancelled'], partial: ['bad', 'partial · cancelled'] };
  const shortSha = (x) => x ? esc(x.slice(0, 7)) : '—';
  function historyHtml(s, view = 'history') {
    const hs = s.history, now = view === 'now';
    let h = '<div class="rl-hist">' + (now ? strayHtml(s) + releaseAllHtml(s) : '');
    if (!now && hs && hs.items && hs.items.length) {
      const has = (k) => hs.items.some(m => k === 'hotfix' ? ['hotfix', 'standalone'].includes(m.kind) : (m.env || 'prod') === k && !['hotfix', 'standalone'].includes(m.kind));
      h += '<div class="rl-hist-filters">' + ['all', 'prod', 'alpha', 'staging', 'hotfix'].filter(k => k === 'all' || has(k))
        .map(k => `<button class="${histFilter === k ? 'on' : ''}" data-act="histFilter" data-f="${k}">${k === 'all' ? 'All' : k === 'hotfix' ? 'Hotfixes' : k[0].toUpperCase() + k.slice(1)}</button>`).join('') + '</div>';
    }
    if (!hs) return h + '<div class="rl-tl-empty">Loading release history…</div></div>';
    if (hs.error) return h + `<div class="rl-rr-flag bad">Release history: ${esc(hs.error)}</div><button class="rl-hist-btn" data-act="histReload">Retry</button></div>`;
    if (!hs.items.length) {
      return h + '<div class="rl-hist-empty"><div class="rl-hist-empty-icon">🚀</div><b>No prod releases recorded yet</b>'
        + '<div>Every Release from now on is recorded here: what shipped, who signed, how it deployed, with a one-click rollback.</div>'
        + ((s.approvers || {}).isApprover ? '<button class="rl-hist-btn go" data-act="histImport">Import past releases from GitHub</button><div class="rl-hist-empty-note">Builds them from your merged release PRs.</div>' : '')
        + '</div></div>';
    }
    const a = s.approvers || {}, meL = (a.me || '').toLowerCase();
    const toSign = new Set((s.toSign || []).map(t => t.repo + '#' + t.number));
    // the release that's live now: the newest prod one that shipped something. Rolling back to it changes nothing,
    // and only its hand steps can be judged against what's live today
    const liveRel = hs.items.find(x => (x.env || 'prod') === 'prod' && x.kind !== 'rollback' && x.repos.some(r => r.mergeSha) && !['abandoned', 'cancelled'].includes(x.status));
    const lives = (s.results && s.results.lives) || {};
    let inTable = false;
    // the release in flight first (as a card), then the table of the rest
    for (let m of hs.items.filter(flight).concat(sortHist(hs.items.filter(x => !flight(x))))) {
      // hand steps in this release's order not confirmed since it opened (nor already up to date)
      const handOpen = (liveRel && m.id === liveRel.id) ? (m.manual || []).filter(x => s.config && (s.config.releaseOrder || []).some(w => w.some(y => y === x.label || y.toLowerCase() === String(x.repo).toLowerCase())))
        .filter(x => { const l = lives[`${x.repo}|${m.env || 'prod'}`]; return !(l && !l.error && (l.behind === 0 || (l.confirmed && Date.parse(l.confirmed.at) >= Date.parse(m.openedAt)))); }).map(x => x.label) : [];
      let [cls, label] = STATUS_CHIP[m.status] || ['', m.status];
      if (m.status === 'merged' && !flight(m)) label = 'merged'; // its deploy result was never recorded: not "deploying" forever
      if (handOpen.length && ['deployed', 'merged'].includes(m.status)) { cls = 'warn'; label = `${label.replace(' ✓', '')} · ${handOpen.length} hand step${handOpen.length === 1 ? '' : 's'} to confirm`; }
      const pending = m.status === 'pending';
      // signed as one: while pending, a signer is someone on every still-open PR
      const openRepos = m.repos.filter(r => !r.mergeSha && !r.closed);
      // who signed the release itself (Sign records it) counts on every PR of it, later ones too
      const relSigned = (m.signedBy || []).map(x => x.login);
      m = { ...m, repos: m.repos.map(r => ({ ...r, signers: [...new Set((r.signers || []).concat(relSigned))] })) };
      const anyone = [...new Set(m.repos.flatMap(r => r.signers || []))];
      const signers = pending && openRepos.length ? anyone.filter(l => openRepos.every(r => (r.signers || []).includes(l))) : anyone;
      const env = m.env || 'prod', signs = env === 'prod'; // only prod is signed (SOC2); alpha / staging just merge
      const needsEye = handOpen.length || (m.status === 'deploy-failed' && liveRel && m.id === liveRel.id); // old failures stay folded
      if (now ? !(flight(m) || needsEye) : flight(m)) continue; // Now: what needs eyes; History: the rest
      const cardOpen = now || rbOpen === m.id || openCards.has(m.id); // History: folded rows, open on click
      if (histFilter !== 'all' && !(histFilter === 'hotfix' ? ['hotfix', 'standalone'].includes(m.kind) : (m.env || 'prod') === histFilter && !['hotfix', 'standalone'].includes(m.kind))) continue;
      if (!now) {
        if (!inTable) { inTable = true; h += histHead(); }
        h += relRow(s, m, signers, cardOpen);
        if (!cardOpen) continue;
        h += '<tr class="rl-hx"><td colspan="7">';
      }
      h += `<div class="rl-hist-card${pending ? ' pending' : ''}"><div class="rl-hist-top">`
        + `<b>${esc(relTitle(m))}</b><span class="rl-hist-id">${esc(m.id)}</span>`
        + (m.kind === 'rollback' ? `<span class="rl-rr-chip">restores ${esc(m.rollbackOf)}</span>` : '')
        + (m.imported ? '<span class="rl-rr-chip" title="Built from merged release PRs, before release manifests existed">imported</span>' : '')
        + (!m.imported && m.repos.some(r => r.unsigned) ? `<span class="rl-rr-chip bad" title="Merged with fewer than 2 approvers' signatures (e.g. on github.com): ${esc(m.repos.filter(r => r.unsigned).map(r => r.label).join(', '))}">merged unsigned ⚠</span>` : '')
        + `<span class="rl-rr-chip ${cls}">${esc(label)}</span>`
        + (env !== 'prod' ? `<span class="rl-env" style="--hue:${ENV_HUE[env.toLowerCase()] || 'var(--dim)'}">${esc(env)}</span>` : '')
        + (pending && signs ? `<span class="rl-rr-chip ${signers.length >= 2 ? 'ok' : 'warn'}" title="The release is signed as one: a signature counts once it covers every open PR of it, and stays as more commits merge in">✍ ${signers.length}/2 signed</span>` : '')
        + (s.cancelling === m.id ? '<span class="rl-rr-chip warn"><span class="rl-spin-dot"></span>cancelling…</span>' : '')
        + (m.kind === 'standalone' ? '<span class="rl-rr-chip" title="A side product shipped on its own: approved by a teammate, not a signed release">standalone deploy</span>' : '')
        + (m.kind === 'hotfix' ? '<span class="rl-rr-chip warn" title="A PR into prod outside the release flow: its own release, needs its own 2 signatures">🩹 hotfix</span>' : '')
        + (m.afterTheFact && m.kind !== 'standalone' ? '<span class="rl-rr-chip bad" title="Merged into prod outside Overlord, recorded after the fact">merged outside Overlord</span>' : '')
        + (m.scope ? `<span class="rl-rr-chip" title="A release of some repos only: ${esc((m.scope.repos || []).join(', '))}">${esc((m.scope.repos || []).length)}${m.scope.of ? ' of ' + esc(m.scope.of) : ''} repos</span>` : '')
        + (m.version ? `<span class="rl-rr-chip" title="Frontend version this release shipped">v${esc(m.version)}</span>` : '')
        + (!m.ticket && ticketLate(s, m) ? `<span class="rl-rr-chip warn" title="${esc(ticketLate(s, m))}">⚠ no ClickUp ticket</span>` : '')
        + (m.ticket ? `<a class="rl-hist-ticket" data-url="${esc(m.ticket.url)}" title="${esc(m.ticket.name)}">ClickUp ticket ↗</a>` : '')
        + (now ? '<button class="rl-hist-btn rl-fold" data-act="nowFold" title="Fold to one line above the board">▴ Collapse</button>' : '')
        + `<span class="rl-hist-when" title="${esc(m.openedAt)}">${age(m.openedAt) === 'now' ? 'just now' : esc(age(m.openedAt)) + ' ago'}</span></div>`
        + `<div class="rl-hist-who">Opened by ${m.openedBy ? '@' + esc(m.openedBy.login) : '?'}${signs && signers.length ? ' · signed by ' + signers.map(x => '@' + esc(x)).join(', ') : ''}</div>`;
      // the release at a glance: how many repos are where
      if (pending || m.status === 'merged' || m.status === 'partial') {
        const cnt = {};
        for (const r of m.repos) { if (r.closed && !r.mergeSha) continue; const k = !r.mergeSha ? 'open' : !r.deploy ? 'merged' : r.deploy.state === 'success' ? 'deployed' : r.deploy.state === 'failure' ? 'deploy failed' : 'deploying'; cnt[k] = (cnt[k] || 0) + 1; }
        const order = ['deployed', 'deploying', 'merged', 'deploy failed', 'open'];
        h += `<div class="rl-hist-summary">${order.filter(k => cnt[k]).map(k => `<span class="rl-sum-${k.replace(' ', '-')}"><b>${cnt[k]}</b> ${k}</span>`).join('<i>·</i>')}</div>`;
      }
      if (flight(m) || (m.status === 'deploy-failed' && (liveRel && m.id === liveRel.id)) || handOpen.length) {
        const nx = releaseNext(s, m);
        const nextTxt = handOpen.length && !nx.next ? `confirm the hand step${handOpen.length === 1 ? '' : 's'}: ${handOpen.join(', ')} (✓ Deployed on the row)` : nx.next;
        if (nextTxt) h += `<div class="rl-next-line ${nx.tone}"><span>Next</span>${esc(nextTxt)}</div>`;
      }
      h += '<div class="rl-hist-repos">';
      const liveItems = s.releaseAll && s.releaseAll.id === m.id && s.releaseAll.items;
      // in release order, one group per wave (what everything depends on first, the frontend last), with
      // the hand-deployed steps in their wave: read top to bottom, it's the release's timeline
      const inOrderMan = (m.manual || []).filter(x => s.config && (s.config.releaseOrder || []).some(w => w.some(y => y === x.label || y.toLowerCase() === String(x.repo).toLowerCase()))).map(x => ({ ...x, hand: true }));
      const waves = s.config && window.ReleasesCore ? ReleasesCore.releaseWaves(s.config, m.repos.concat(inOrderMan)) : [m.repos];
      // a step's state from its repos: done / in progress / waiting / failed / not started
      const stOf = (r) => { const it = liveItems && liveItems[r.label]; if (it) return it.s; if (r.hand) return ''; if (r.mergeSha) return r.deploy ? (r.deploy.state === 'success' ? 'deployed' : r.deploy.state === 'failure' ? 'failed' : 'deploying') : 'merged-hand'; return ''; };
      const live = new Set(['merging', 'merged', 'deploying', 'hand-wait']);
      let notDeployed = []; // earlier waves' repos not deployed yet: merging past them warns
      waves.forEach((wave, wi) => {
      // a hand-deployed step nobody confirmed this run says nothing about the wave
      const ss = wave.filter(r => !r.hand || (liveItems && liveItems[r.label])).map(stOf);
      const wst = !ss.length ? 'todo' : ss.every(x => DONE.has(x)) ? 'done' : ss.some(x => x === 'failed') ? 'bad' : ss.some(x => live.has(x)) ? 'active' : ss.some(x => x === 'held') ? 'warn' : 'todo';
      const wsum = { done: flight(m) ? 'done' : '', bad: 'deploy failed', active: 'in progress', warn: `${ss.filter(x => x === 'held').length} waiting`, todo: '' }[wst];
      h += `<div class="rl-tl-step ${wst}"><i class="rl-tl-node">${wst === 'done' ? '✓' : wi + 1}</i><span class="rl-tl-name">${waves.length > 1 ? `Wave ${wi + 1}` : 'Repos'}</span>${wsum ? `<span class="rl-tl-sum">${esc(wsum)}</span>` : ''}</div><div class="rl-tl-rows ${wst}">`;
      for (const r of wave) {
        if (r.hand) {
          const it = liveItems && liveItems[r.label];
          const handDone = (it && it.s === 'hand-done') || !handOpen.includes(r.label);
          const handBtn = (['pending', 'merged', 'partial'].includes(m.status) || handOpen.includes(r.label)) && a.isApprover && !(it && it.s === 'hand-done') && !((liveRel && m.id === liveRel.id) && handDone) ? (armed === 'h:' + r.repo
            ? `<button class="rl-row-btn armed" data-act="rowHand" data-repo="${esc(r.repo)}" data-label="${esc(r.label)}">Confirm: deployed</button>`
            : `<button class="rl-row-btn" data-act="rowHand" data-repo="${esc(r.repo)}" data-label="${esc(r.label)}" title="Record ${esc(r.label)} as deployed now (its branch head goes live)">✓ Deployed</button>`) : '';
          h += `<div class="rl-hist-repo hand"><b>${esc(r.label)}</b><span></span><span class="rl-hist-sha"><span class="rl-hand">✋ by hand</span></span><span class="rl-hist-state">${handBtn}${it ? relItemHtml(it) : (liveRel && m.id === liveRel.id) ? relItemHtml({ s: handDone ? 'hand-done' : 'hand-wait' }) : ''}</span></div>`;
          continue;
        }
        const need = pending && !r.mergeSha && !r.closed;
        const signed = (r.signers || []).length;
        const cmp = r.baseSha && (r.mergeSha || r.headSha) ? `https://github.com/${r.repo}/compare/${r.baseSha}...${r.mergeSha || r.headSha}` : null;
        const dep = deployPill(r, s);
        const chKey = m.id + ':' + r.repo, chOpen = openChanges.has(chKey);
        h += `<div class="rl-hist-repo"><b>${esc(r.label)}</b>${link(r.pr.url, '#' + r.pr.number)}`
          + `<span class="rl-hist-sha">${r.changes && r.changes.length ? `<button class="rl-ch-btn${chOpen ? ' on' : ''}" data-act="histChanges" data-key="${esc(chKey)}" title="The PRs this release brought into ${esc(r.label)}">${r.changes.length} change${r.changes.length === 1 ? '' : 's'} ${chOpen ? '▴' : '▾'}</button>` : ''}${cmp ? `<span title="prod before → after">${link(cmp, shortSha(r.baseSha) + ' → ' + shortSha(r.mergeSha || r.headSha))}</span>` : ''}</span>`
          + `<span class="rl-hist-state">${rowActs(r, need, notDeployed)}${need && r.signedSha && r.headSha && r.signedSha !== r.headSha ? `<a class="rl-unsigned-new" data-url="${esc(`https://github.com/${r.repo}/compare/${r.signedSha}...${r.headSha}`)}" title="Commits that landed after the last signature: they ship without anyone signing them">+ since signed ↗</a>` : ''}${r.mergeSha ? (liveItems && liveItems[r.label] && liveItems[r.label].s === 'deploying' && !(r.deploy && ['success', 'failure'].includes(r.deploy.state)) ? relItemHtml(liveItems[r.label]) : dep) : liveItems && liveItems[r.label] ? relItemHtml(liveItems[r.label]) : r.closed && !r.mergeSha ? 'closed' : need ? (r.health ? histHealth(r.health) + ' ' : '') + (!signs ? '' : (() => { const miss = signers.length >= 2 ? [] : anyone.filter(l => !(r.signers || []).includes(l)); return miss.length ? `<span class="warn" title="Signed the rest of the release but not this PR's latest commit">✍ needs ${miss.map(l => '@' + esc(l)).join(', ')}</span>` : '✍ ✓'; })()) + (toSign.has(r.repo + '#' + r.pr.number) ? ' · needs you' : '') : r.mergeSha ? dep : ''}</span></div>`;
        if (chOpen && r.changes) h += `<div class="rl-ch-list">${r.changes.map(c => `<div>${link(`https://github.com/${r.repo}/pull/${c.n}`, '#' + c.n)} ${esc(c.title)}</div>`).join('')}</div>`;
      }
      notDeployed = notDeployed.concat(wave.filter(r => !r.hand && !DONE.has(stOf(r))).map(r => r.label));
      h += '</div>';
      });
      h += '</div>';
      const manOther = (m.manual || []).filter(x => !inOrderMan.some(y => y.repo === x.repo));
      if (manOther.length) h += `<div class="rl-hist-man" title="${esc(manOther.map(x => x.label + (x.live && x.live.sha ? ': live ' + x.live.sha.slice(0, 7) : '')).join(' · '))}">Not in this release (deployed by hand): ${manOther.map(x => esc(x.label)).join(', ')}</div>`;
      if (m.warnings && m.warnings.length) h += `<div class="rl-hist-man bad">⚠ Not rolled back (data changes): ${m.warnings.map(w => esc(w.label) + ': ' + w.files.map(esc).join(', ')).join(' · ')}</div>`;
      if (m.flags && m.flags.missing && m.flags.missing.length) h += `<div class="rl-hist-man bad">Flags to seed: ${esc(m.flags.missing.join(', '))}</div>`;
      // actions
      const acts = [];
      if (signs && pending && a.isApprover && m.repos.some(r => toSign.has(r.repo + '#' + r.pr.number))) acts.push(signBtn(s, 'rl-hist-btn go', '✍ Sign'));
      // (an open back-merge doesn't hold a repo: Release all merges it first)
      // (failing checks don't hold a repo either: GitHub's branch protection decides; only a conflict does)
      const held = (r) => r.health && (r.health.backMerge && r.health.backMerge.conflict ? `its back-merge #${r.health.backMerge.number} conflicts` : r.health.conflict ? 'conflicts with its target' : null);
      if (pending && a.isApprover) acts.push(releaseAllBtn(s, {
        ready: !signs || signers.length >= 2 ? openRepos.filter(r => !held(r)) : [],
        waiting: !signs || signers.length >= 2 ? [] : openRepos, held: openRepos.filter(held).map(r => ({ label: r.label, why: held(r) })),
        signoff: { count: signers.length, need: 2, signers, gaps: anyone.filter(l => !signers.includes(l))
          .map(login => ({ login, missing: openRepos.filter(r => !(r.signers || []).includes(login)).map(r => ({ label: r.label })) })) },
        attrs: `class="rl-hist-btn" data-act="histMerge" data-id="${esc(m.id)}"`, lockedCls: 'rl-hist-btn', armKey: 'h:' + m.id }));
      if (pending && a.isApprover && (m.kind || 'release') === 'release' && !(s.releaseAll && s.releaseAll.running)) acts.push(`<button class="rl-hist-btn" data-act="relAddTo" data-env="${esc(m.env || 'prod')}" title="Open the release picker to add repos to this release">➕ Add repos</button>`);
      if (pending && a.isApprover && openRepos.length && !(s.releaseAll && s.releaseAll.running)) acts.push(cancelBtn(m.id, openRepos.length, 'rl-hist-btn'));
      if (m.cancelled) h += `<div class="rl-hist-man${m.status === 'partial' ? ' bad' : ''}">✕ Cancelled by @${esc(m.cancelled.by || '?')} · ${esc(age(m.cancelled.at))} ago`
        + (m.cancelled.never && m.cancelled.never.length ? ` · never shipped: ${esc(m.cancelled.never.join(', '))}` : '') + (m.status === 'partial' ? ' · the rest is live in prod' : '') + '</div>';
      if (!pending && !(liveRel && m.id === liveRel.id) && (m.env || 'prod') === 'prod' && !['abandoned', 'cancelled'].includes(m.status) && m.repos.some(r => r.mergeSha) && a.isApprover) {
        acts.push(`<button class="rl-hist-btn${rbOpen === m.id ? ' on' : ''}" data-act="histRollback" data-id="${esc(m.id)}" title="Puts prod back to exactly what this release shipped (as signed rollback PRs)">↩ Roll back prod to this release</button>`);
      }
      if (acts.length) h += '<div class="rl-hist-acts">' + acts.join('') + '</div>';
      if (rbOpen === m.id) {
        h += '<div class="rl-hist-rb"><div>Open rollback PRs that put prod back exactly as this release left it. Each needs 2 approvers\' signatures, like any release.</div>';
        for (const r of m.repos.filter(x => x.mergeSha)) {
          h += `<label class="rl-hist-rb-repo"><input type="checkbox" data-act="histRbRepo" data-repo="${esc(r.repo)}"${rbSkip.has(r.repo) ? '' : ' checked'}>`
            + `<b>${esc(r.label)}</b><span>${esc(r.target)} → ${shortSha(r.mergeSha)}</span></label>`;
        }
        h += `<button class="rl-hist-btn danger" data-act="histRbGo" data-id="${esc(m.id)}">↩ Open rollback PRs</button></div>`;
      }
      h += '</div>';
      if (!now) h += '</td></tr>';
    }
    return h + (inTable ? '</tbody></table>' : '') + '</div>';
  }

  // 👥 Release approvers: the GitHub team whose members may release and sign prod. Editing is up
  // to GitHub: team maintainers can add/remove here, everyone else sees the list.
  // Why Release is off for this person, and who can change that
  // Start release: approvers only (and a recent enough Overlord); for anyone else it stays visible, locked, saying why
  function startBtn(s) {
    const why = s.config && s.config.minOverlord && s.appVersion && !ReleasesCore.versionAtLeast(s.appVersion, s.config.minOverlord)
      ? `Update Overlord to ${s.config.minOverlord} or later to release (this is ${s.appVersion}): older versions miss release rules`
      : s.approvers && s.approvers.me && !s.approvers.isApprover ? releaseLockedTip(s.approvers) : null;
    if (why) return `<button class="go locked" aria-disabled="true" title="${esc(why)}">🔒 Start release</button>`;
    return `<button class="go" data-act="releaseGo"${relSel.size ? '' : ' disabled'}>Start release</button>`;
  }
  function releaseLockedTip(a) {
    if (!a.exists) return 'Releasing needs a release approvers team. Open 👥 Approvers to create it.';
    const who = a.members.map(m => '@' + m.login).join(', ');
    return `Only release approvers can release: prod needs two of them to sign. You're @${a.me}, not on the team${who ? ` (${who})` : ''}. A team maintainer can add you in 👥 Approvers.`;
  }

  function approversHtml(s) {
    const a = s.approvers || {};
    let h = `<div class="rl-rel-pop rl-appr${relShown ? ' still' : ''}"><div class="rl-rel-head"><span>Release approvers</span></div>`;
    relShown = true;
    h += `<div class="rl-appr-note">Prod releases need <b>2</b> of these people: whoever opens the release, plus one approval (✍ Sign). Overlord won't merge a prod release PR before that.</div>`;
    if (!a.org) h += '<div class="rl-rr-flag">Loading…</div>';
    else if (a.error) h += `<div class="rl-rr-flag bad">${esc(a.error)}</div>`;
    else if (!a.exists) {
      h += `<div class="rl-appr-note">There's no <code>${esc(a.org)}/${esc(a.team)}</code> team yet.</div>`
        + '<div class="rl-rel-actions"><button class="go" data-act="apprCreate">Create the approvers team</button></div>';
    } else {
      h += '<div class="rl-appr-list">' + (a.members.length ? a.members.map(m => `<div class="rl-appr-row">`
        + `<img src="${esc(m.avatar)}&s=48" alt=""><b>@${esc(m.login)}</b>${m.login.toLowerCase() === (a.me || '').toLowerCase() ? '<span class="rl-appr-you">you</span>' : ''}`
        + (a.canEdit ? `<button class="rl-appr-x" data-act="apprRemove" data-login="${esc(m.login)}" title="Remove @${esc(m.login)}">×</button>` : '') + '</div>').join('')
        : '<div class="rl-rr-flag">No approvers yet</div>') + '</div>';
      if (a.canEdit) h += '<div class="rl-appr-add"><input id="rl-appr-add" placeholder="GitHub username" spellcheck="false"><button data-act="apprAdd">Add</button></div>';
      else h += `<div class="rl-appr-note dim">Only maintainers of <code>${esc(a.team)}</code> can change the list${a.me ? ` (you're @${esc(a.me)}${a.isApprover ? ', an approver' : ''})` : ''}.</div>`;
      if (a.members.length && a.members.length < 2) h += '<div class="rl-rr-flag bad">Fewer than 2 approvers: no prod release can be signed.</div>';
    }
    if (a.me && !a.meClickup) h += '<div class="rl-appr-note dim">Connect ClickUp in Settings so your signature assigns you on the release ticket.</div>';
    return h + '</div>';
  }

  // The run's results: one row per release PR as it goes (open/reuse → back-merge → mergeable →
  // checks), a Fix on anything blocked, then the hand-deployed envs and the flag check.
  function releaseResultsHtml(s) {
    const run = s.releaseRun;
    const prLink = (p, label) => p && p.url ? link(p.url, label) : '';
    const pending = !run.running && run.rows.some(r => r.pr && !r.merged && !r.closed && (r.checks === 'pending' || r.checks === 'none' || r.conflict === null));
    let h = `<div class="rl-rel-pop rl-rr${relShown ? ' still' : ''}"><div class="rl-rel-head"><span>Release ${esc(run.envs.join(' + '))} · ${esc(age(new Date(run.startedAt).toISOString()))} ago</span>`
      + (run.running ? '<span class="rl-rr-spin">running…</span>' : pending ? '<span class="rl-rr-spin" title="Re-checking open PRs every minute">watching checks…</span>' : '')
      + '</div><div class="rl-rr-rows">';
    relShown = true;
    // compact: closed PRs and repos with nothing to release collapse into one line at the end
    const quiet = run.running ? [] : run.rows.filter(r => r.closed || r.status === 'nothing');
    run.rows.forEach((r, i) => {
      if (quiet.includes(r)) return;
      const env = `<span class="rl-env" style="--hue:${ENV_HUE[r.env.toLowerCase()] || 'var(--dim)'}">${esc(r.env)}</span>`;
      const bits = [];
      if (r.running && !r.pr) bits.push('<span class="rl-rr-chip">checking…</span>');
      if (r.status === 'nothing') bits.push('<span class="rl-rr-chip">nothing to release</span>');
      if (r.backMerge && r.backMerge.url) bits.push(`<span class="rl-rr-chip${r.backMerge.conflict ? ' bad' : ' warn'}" title="Back-merge ${esc(r.target)} → ${esc(r.source)}: merge it first">back-merge ${prLink(r.backMerge, '#' + r.backMerge.number)}${r.backMerge.conflict ? ' conflicts' : ' first'}</span>`);
      // the release is signed as one (count in the footer); a row only says who it's still missing
      if (r.env === 'prod' && run.signoff && !run.signoff.ok && !r.merged && !r.closed) {
        const gap = run.signoff.gaps.map(g => [g.login, g.missing.find(x => x.label === r.label)]).filter(([, x]) => x);
        if (gap.length) bits.push(`<span class="rl-rr-chip warn" title="Their signature on the release doesn't cover this PR yet">✍ ${gap.map(([l, x]) => '@' + esc(l) + (x.older ? ' (new commits)' : '')).join(', ')} to sign</span>`);
      }
      if (r.merged) bits.push('<span class="rl-rr-chip ok">merged ✓</span>');
      else if (r.closed) bits.push('<span class="rl-rr-chip">closed</span>');
      if (r.conflict === true) bits.push('<span class="rl-rr-chip bad">conflicts</span>');
      if (r.pr && r.conflict === null && !r.merged && !r.closed && !r.running) bits.push('<span class="rl-rr-chip" title="GitHub is still working out whether it merges cleanly">mergeable?</span>');
      if (r.checks === 'fail') bits.push('<span class="rl-rr-chip bad">checks failing</span>');
      if (r.checks === 'pending') bits.push('<span class="rl-rr-chip">checks running</span>');
      if (r.checks === 'pass') bits.push('<span class="rl-rr-chip ok">checks green</span>');
      // the source branch's own deploy is red (board: that env's last deploy run) — merging runs
      // the same build for the target, so it will likely fail there too. A warning, not a block.
      const srcRow = s.grid && s.grid.rows.find(x => x.repo === r.repo);
      const srcCell = srcRow && (srcRow.cells || []).find(c => c && c.branch === r.source && c.run);
      if (srcCell && srcCell.run.state === 'failure') {
        const what = (srcCell.run.failed || []).map(f => f.job + (f.step ? ' › ' + f.step : '')).join('; ') || 'its deploy';
        bits.push(`<span class="rl-rr-chip warn" title="${esc(r.source)}'s own deploy is failing, so the ${esc(r.env)} deploy will likely fail the same way: ${esc(what)}">⚠ ${esc(r.source)} deploy failing</span>`);
      }
      // dbschemas: blocked when the release uses a field its build won't ship; otherwise info
      const d = r.dbschemas;
      if (d && d.used && d.used.length) bits.push(`<span class="rl-rr-chip bad" title="Added in dbschemas after ${esc(d.shipped)} — bump @llsltd/dbschemas to ${esc(d.latest)} before merging">✕ uses ${esc(d.used.join(', '))} but ships dbschemas ${esc(d.shipped)}</span>`);
      else if (d && d.otherLine) bits.push(`<span class="rl-rr-chip warn" title="Latest is ${esc(d.latest)}: a different major line, so fields can't be compared">dbschemas ${esc(d.shipped)} (old line)</span>`);
      else if (d && d.shipped && d.shipped !== d.latest) bits.push(`<span class="rl-rr-chip" title="${esc((d.newFields || []).join(', ') || 'no new fields')}">dbschemas ${esc(d.shipped)} · ${d.behind != null ? d.behind + ' change' + (d.behind === 1 ? '' : 's') + ' behind' : 'behind ' + esc(d.latest)}</span>`);
      else if (d && d.shipped) bits.push(`<span class="rl-rr-chip ok">dbschemas ${esc(d.shipped)}${d.via === 'latest' ? ' (latest at build)' : ''}</span>`);
      if (r.pr && !r.running && r.builds === 'none') bits.push('<span class="rl-rr-chip warn" title="No check on this PR builds or tests it, so nothing verifies it still builds after merging">⚠ no CI build</span>');
      if (r.advisory && r.advisory.length) bits.push(`<span class="rl-rr-chip" title="Failing, but ${esc(r.target)}'s branch protection doesn't require them, so merging isn't blocked: ${esc(r.advisory.join(', '))}">not required: ${esc([...new Set(r.advisory.map(x => x.replace(/\s*\(.*\)$/, '')))].join(', '))}</span>`);
      if (r.knownFailing && r.knownFailing.length) bits.push(`<span class="rl-rr-chip" title="Also failing on ${esc(r.target)}: red before this release, so not counted">red before: ${esc(r.knownFailing.join(', '))}</span>`);
      if (r.error) bits.push(`<span class="rl-rr-chip bad" title="${esc(r.error)}">✕ ${esc(r.error.slice(0, 60))}</span>`);
      h += `<div class="rl-rr-row st-${esc(r.status || 'running')}"><div class="rl-rr-top"><b>${esc(r.label)}</b>${env}`
        + `<span class="rl-rr-branches">${esc(r.source)} → ${esc(r.target)}</span>`
        + (r.pr ? `<span class="rl-rr-pr">${prLink(r.pr, `#${r.pr.number}`)}${r.ahead ? ` · ${r.ahead} commits` : ''}</span>` : '')
        + (!r.running && (r.status === 'blocked' || r.status === 'error') ? `<button class="rl-rr-fix1" data-act="relFix" data-i="${i}" title="Start an agent that unblocks just ${esc(r.label)} ${esc(r.env)}">🔧 Fix</button>` : '')
        + `</div><div class="rl-rr-bits">${bits.join('')}</div></div>`;
    });
    h += '</div>';
    if (quiet.length) h += `<div class="rl-rr-quiet" title="${esc(quiet.map(r => `${r.label} ${r.env}: ${r.closed ? 'its PR was closed' : 'nothing to release'}`).join(' · '))}">Nothing to release: ${esc([...new Set(quiet.map(r => r.label))].join(', '))}</div>`;
    if (run.manual.length) {
      h += '<div class="rl-rr-sub">Deployed by hand: nothing to PR</div>';
      for (const m of run.manual) {
        const row = s.grid && s.grid.rows.find(x => x.repo === m.repo);
        const cell = row && row.cells && row.cells[s.grid.envs.indexOf(m.env)];
        const live = cell && cell.live && !cell.live.error
          ? `live ${esc(cell.live.sha.slice(0, 7))}${cell.live.behind ? ` · <b>${cell.live.behind}</b> not live` : ' · up to date'}` : 'live commit unknown';
        h += `<div class="rl-rr-man">✋ <b>${esc(m.label)}</b> <span class="rl-env" style="--hue:${ENV_HUE[m.env.toLowerCase()] || 'var(--dim)'}">${esc(m.env)}</span> <span>${live}</span></div>`;
      }
    }
    if (run.flags && run.flags.missing && run.flags.missing.length) h += `<div class="rl-rr-flag bad">⚠ Seed these prod feature flags before merging: ${esc(run.flags.missing.join(', '))}</div>`;
    else if (run.flags && run.flags.missing) h += '<div class="rl-rr-flag">Prod feature flags: nothing missing</div>';
    else if (run.flags && run.flags.error) h += `<div class="rl-rr-flag">Flag check failed: ${esc(run.flags.error)}</div>`;
    const blocked = run.running ? 0 : run.rows.filter(r => r.status === 'blocked' || r.status === 'error').length;
    const a = s.approvers || {};
    const meL = (a.me || '').toLowerCase();
    const open = run.running ? [] : run.rows.filter(r => r.pr && !r.merged && !r.closed);
    const toSign = a.isApprover ? new Set([...open.filter(r => r.env === 'prod' && r.signoff && !r.signoff.signers.some(x => x.login.toLowerCase() === meL)).map(r => r.repo + '#' + r.pr.number),
      ...(s.toSign || []).map(x => x.repo + '#' + x.number)]).size : 0;
    // what Release all would actually merge now, by env — and the prod PRs still waiting for signatures
    const relOk = !!(run.signoff && run.signoff.ok);
    const readyRows = open.filter(r => r.status === 'ok' && r.conflict === false && (r.env !== 'prod' || relOk));
    const unsignedProd = relOk ? [] : open.filter(r => r.env === 'prod');
    if (run.signoff) h += `<div class="rl-rr-flag${run.signoff.ok ? '' : ' bad'}">✍ Prod release signed ${run.signoff.count}/${run.signoff.need}${run.signoff.count ? ' · ' + run.signoff.signers.map(x => '@' + esc(x.login)).join(', ') : ''}</div>`;
    // once the run is recorded as a release, it's managed in one place: the release card (shared with the team)
    const recorded = open.length && ((s.history && s.history.items) || []).some(m => m.repos.some(x => open.some(r => r.repo === x.repo && r.pr.number === x.pr.number)));
    h += (recorded ? '' : releaseAllHtml(s)) + '<div class="rl-rel-actions">'
      + (recorded ? '<button class="rl-rr-merge" data-act="gotoRelease" title="Sign, release, merge one, fix and watch it there: the team sees the same card">Manage this release →</button>' : (toSign ? signBtn(s, 'rl-rr-sign', '✍ Sign the release', `Approve every prod release PR as @${a.me}: your signature`) : '')
      + releaseAllBtn(s, { ready: readyRows, waiting: unsignedProd, signoff: run.signoff && { ...run.signoff, signers: run.signoff.signers.map(x => x.login) },
        attrs: 'class="rl-rr-merge" data-act="relMerge"', lockedCls: 'rl-rr-merge', armKey: 'run' })
      + (open.length && (s.approvers || {}).isApprover && !(s.releaseAll && s.releaseAll.running) ? cancelBtn('', open.length, 'rl-rr-cancel') : ''))
      + (blocked ? `<button class="rl-rr-fix" data-act="relFix" title="One agent unblocks every blocked row">🔧 Fix all (${blocked})</button>` : '')
      // a new release only once this one's PRs are all merged or closed (Release again just reuses open PRs anyway)
      + (run.running || open.length ? '' : '<button data-act="relNew">New release</button>')
      + '<button data-act="releaseClose">Close</button></div></div>';
    return h;
  }

  // Repos in the release config the PRs panel doesn't watch yet; null when that panel is off.
  // prSettings is index.html's (a shared global), refreshed whenever main echoes the settings.
  // The repos the release map promotes: every teammate watches at least these for PRs.
  function releaseRepos() {
    return state && state.config && Array.isArray(state.config.repos) ? [...new Set(state.config.repos.filter(r => r.branches).map(r => r.repo))] : [];
  }
  // Missing release repos are added (and PR notifications turned on) as soon as both the release config and the
  // PR settings have loaded — prSettingsLoaded guards against overwriting repos with the empty startup default.
  function enforcePrWatch() {
    if (typeof prSettingsLoaded === 'undefined' || !prSettingsLoaded) return;
    const rel = releaseRepos(); if (!rel.length) return;
    const have = new Set((prSettings.repos || []).map(r => r.toLowerCase()));
    const missing = rel.filter(r => !have.has(r.toLowerCase()));
    if (!missing.length && prSettings.enabled) return;
    prSettings = { ...prSettings, enabled: true, repos: [...(prSettings.repos || []), ...missing] };
    selectedRepos = new Set(prSettings.repos);
    api.send({ type: 'savePrSettings', prSettings });
    if (typeof showToast === 'function') showToast(missing.length ? `Watching PRs on the ${missing.length} release repo${missing.length === 1 ? '' : 's'} you weren't watching` : 'PR notifications are on: the team watches the release repos');
  }
  function prsUnwatched() {
    if (typeof prSettings === 'undefined' || !prSettings.enabled || !state || !state.config) return null;
    const have = new Set((prSettings.repos || []).map(r => r.toLowerCase()));
    return [...new Set(state.config.repos.filter(r => r.branches).map(r => r.repo))].filter(r => !have.has(r.toLowerCase()));
  }

  // Release picker: one toggle per env the config promotes into, with what's waiting for it;
  // the footer says what the agent will do (PRs to open, hand-deployed envs to report).
  function toSignHtml(s) {
    const t = s.toSign || [];
    if (!t.length) return '';
    const by = [...new Set(t.flatMap(x => x.signers))].map(x => '@' + esc(x)).join(', ');
    return '<div class="rl-tosign"><div class="rl-tosign-head">✍ Waiting for your signature</div>'
      + t.map(x => `<div class="rl-tosign-row"><b>${esc(x.label)}</b>${link(x.url, '#' + x.number)}</div>`).join('')
      + `<div class="rl-tosign-by">${by ? 'Opened by ' + by + '. ' : ''}One signature covers the whole release: ${t[0].count}/${t[0].need} signed so far.</div>`
      + signBtn(s, 'rl-rr-sign', '✍ Sign the release') + '</div>';
  }

  function releasePickerHtml(s) {
    const cfg = s.config, targets = ReleasesCore.releaseTargets(cfg);
    const waiting = {};
    for (const row of (s.grid && s.grid.rows) || []) for (const c of row.cells || []) for (const n of (c && c.nexts) || []) {
      if (n.ahead) waiting[n.to] = (waiting[n.to] || 0) + n.ahead;
    }
    const fullPlan = ReleasesCore.releasePlan(cfg, [...relSel]);
    // the repos it would release: each one's waiting commits for the picked envs; untick to leave it out
    const repoWait = {};
    for (const row of (s.grid && s.grid.rows) || []) for (const c of row.cells || []) for (const n of (c && c.nexts) || []) {
      if (n.ahead && relSel.has(n.to)) repoWait[row.repo] = (repoWait[row.repo] || 0) + n.ahead;
    }
    const planRepos = [...new Map(fullPlan.prs.map(p => [p.repo, p])).values()].filter(p => repoWait[p.repo]);
    const plan = { prs: fullPlan.prs.filter(p => !relSkip.has(p.repo) && repoWait[p.repo]), manual: relSkip.size ? [] : fullPlan.manual }; // releasing some repos: the hand-deployed ones aren't part of it
    const unwatched = prsUnwatched();
    const bell = !unwatched ? ''
      : `<button class="rl-rel-bell${unwatched.length ? '' : ' done'}" data-act="relWatch" title="${unwatched.length
        ? `Watch PRs for the ${unwatched.length} release repo${unwatched.length === 1 ? '' : 's'} not in the PRs panel yet: ${esc(unwatched.map(r => r.split('/')[1]).join(', '))}`
        : 'Every release repo is already in the PRs panel'}"${unwatched.length ? '' : ' disabled'}>`
        + '<svg class="ic" viewBox="0 0 24 24"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>'
        + (unwatched.length ? `<i>${unwatched.length}</i>` : '') + '</button>';
    let h = `<div class="rl-rel-pop${relShown ? ' still' : ''}">${toSignHtml(s)}<div class="rl-rel-head"><span>Release to</span>${bell}</div><div class="rl-rel-envs">`;
    relShown = true;
    for (const e of targets) {
      h += `<button class="rl-rel-env${relSel.has(e) ? ' on' : ''}" data-act="relToggle" data-env="${esc(e)}">`
        + `<span class="rl-env" style="--hue:${ENV_HUE[e.toLowerCase()] || 'var(--dim)'}">${esc(e)}</span>`
        + `<span class="rl-rel-wait">${waiting[e] ? `<b>${waiting[e]}</b> waiting` : 'up to date'}</span></button>`;
    }
    h += '</div>';
    if (relSel.size && planRepos.length) {
      const allOn = !planRepos.some(p => relSkip.has(p.repo));
      h += `<div class="rl-rel-head rl-rel-repos-head"><span>Repos</span><button class="rl-rel-all" data-act="relReposAll" data-on="${allOn ? 0 : 1}">${allOn ? 'None' : 'All'}</button></div><div class="rl-rel-repos">`
        + planRepos.map(p => {
          const inRel = pendingWith(s, p.repo);
          return `<div class="rl-rel-repo-row"><button class="rl-rel-repo${relSkip.has(p.repo) ? '' : ' on'}" data-act="relRepo" data-repo="${esc(p.repo)}" title="${relSkip.has(p.repo) ? 'Left out of this release' : 'In this release'}">`
            + `<i></i><b>${esc(p.label)}</b><span>${inRel ? `<em title="Its release PR is already in pending release ${esc(inRel)}: picking it alone just joins that release">in ${esc(inRel.slice(5))}</em> · ` : ''}${repoWait[p.repo]} waiting</span></button>`
            + `<button class="rl-rel-only" data-act="relOnly" data-repo="${esc(p.repo)}" title="Release just ${esc(p.label)}">only</button></div>`;
        }).join('') + '</div>';
      // a later-wave repo going without an earlier-wave repo that has unreleased work: it may depend on it
      const picked = planRepos.filter(p => !relSkip.has(p.repo)), left = planRepos.filter(p => relSkip.has(p.repo));
      if (picked.length && left.length && cfg.releaseOrder) {
        const waveOf = (p) => cfg.releaseOrder.findIndex(w => w.some(x => x === p.label || x.toLowerCase() === p.repo.toLowerCase()));
        const lastPicked = Math.max(...picked.map(waveOf));
        const before = left.filter(p => { const w = waveOf(p); return w >= 0 && w < lastPicked; });
        if (before.length) h += `<div class="rl-rr-flag warn" title="Release order puts them first: what's picked may rely on their unreleased changes">⚠ Left out, but earlier in the release order: ${before.map(p => `${esc(p.label)} (${repoWait[p.repo]} waiting)`).join(', ')}. ${esc(picked.filter(p => waveOf(p) === lastPicked).map(p => p.label).join(', '))} may need them.</div>`;
      }
    }
    // a pending release of a picked env: what's picked joins it (or, on request, a release of its own)
    const pend = ((s.history && s.history.items) || []).find(m => m.status === 'pending' && relSel.has(m.env || 'prod') && (m.kind || 'release') === 'release');
    if (pend && relSel.size) h += `<div class="rl-rel-join${relSeparate ? ' off' : ''}">${relSeparate
      ? `Starts a <b>separate</b> release (release ${esc(pend.id)} is pending) <button data-act="relSep">add to it instead</button>`
      : `➕ Adds to pending release <b>${esc(pend.id)}</b> (${pend.repos.filter(r => !r.mergeSha && !r.closed).length} open) <button data-act="relSep">start a separate one</button>`}</div>`;
    h += '<div class="rl-rel-sum">' + (relSel.size
      ? `${plan.prs.length} release PR${plan.prs.length === 1 ? '' : 's'} to check and open${relSkip.size && plan.prs.length ? ': ' + esc([...new Set(plan.prs.map(p => p.label))].join(', ')) : ''}`
        + (plan.manual.length ? ` · ${plan.manual.length} hand-deployed to report` : '')
      : 'Pick one or more environments') + '</div>'
      + '<div class="rl-rel-note">Overlord opens the release PRs (plus back-merges when needed) and checks each one. Nothing merges until 2 approvers sign and someone presses Release all.</div>'
      + `<div class="rl-rel-actions"><button data-act="releaseClose">Cancel</button>${startBtn(s)}</div></div>`;
    return h;
  }

  // Hovering Release opens the picker; leaving both the button and the picker closes it after a
  // beat (long enough to cross the gap between them).
  const REL_ZONE = '.rl-release:not(.locked), .rl-rel-pop:not(.rl-appr)'; // the approvers panel isn't part of the Release hover
  let relLeave = null;
  overlay.addEventListener('mouseover', (ev) => {
    if (!ev.target.closest || !ev.target.closest(REL_ZONE)) return;
    clearTimeout(relLeave);
    actions.releaseMenu();
  });
  overlay.addEventListener('mouseout', (ev) => {
    if (!ev.target.closest || !ev.target.closest(REL_ZONE)) return;
    if (ev.relatedTarget && ev.relatedTarget.closest && ev.relatedTarget.closest(REL_ZONE)) return;
    if (state && state.releaseRun) return;
    clearTimeout(relLeave);
    relLeave = setTimeout(() => { if (relOpen) actions.releaseClose(); }, 400);
  });

  function render() { renderNow(); if (open) applyBusy(modal); }
  function renderNow() {
    tlTip.classList.remove('show');
    if (!open) return;
    const s = state || { source: '', loading: true };
    const upd = s.updatedAt ? `updated ${new Date(s.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
    let h = '<div class="rl-head"><h2>Releases</h2>'
      + `<button class="rl-src-btn" data-act="editSource" title="Release config: ${esc(s.source)} (click to change)">⚙</button>`
      + (s.rateLimitedUntil && s.rateLimitedUntil > Date.now() ? `<span class="rl-upd bad" title="GitHub's API limit (shared by every tool on your account) was hit: background updates pause until then. What you click still goes through.">GitHub limit: paused until ${new Date(s.rateLimitedUntil).toTimeString().slice(0, 5)}</span>` : '')
      + `<span class="rl-upd">${s.loading ? 'loading…' : esc(upd)}</span>`
      + (s.config ? `<button class="rl-appr-btn${apprOpen ? ' on' : ''}" data-act="apprMenu" title="Release approvers: releasing and merging prod needs two of them"><svg class="ic" viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`
        + `<span>${s.approvers && s.approvers.members ? s.approvers.members.length : ''}</span></button>` : '')
      + (s.config && window.ReleasesCore && ReleasesCore.releaseTargets(s.config).length
        // everyone can open the picker (what's waiting, the PR-watch bell); only Start release is for approvers
        ? `<button class="rl-release${relOpen ? ' on' : ''}" data-act="releaseMenu" title="What's waiting to release, per env">`
          + '<svg class="ic" viewBox="0 0 24 24"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>Release</button>'
        : '')
      + `<button data-act="refresh" class="${s.loading ? 'spin' : ''}" title="Refresh"><svg class="ic" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/></svg></button>`
      + '<button data-act="close" title="Close (Esc)"><svg class="ic" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>'
      + (s.grid && s.config ? '<div class="rl-nav">'
        + [['envs', 'Environments', 'What\'s on each env, and the release in flight'], ['history', 'History', 'Every past release']]
          .map(([k, t, tip]) => `<button data-act="tab" data-tab="${k}" class="${tab === k ? 'on' : ''}" title="${tip}">${t}${k === 'envs' && activeRelease(s) ? '<i class="rl-live-dot"></i>' : ''}</button>`).join('')
        + (tab === 'envs' ? `<div class="rl-seg"><button data-act="envView" data-v="board" class="${envView === 'board' ? 'on' : ''}">Board</button><button data-act="envView" data-v="timeline" class="${envView === 'timeline' ? 'on' : ''}">Timeline</button></div>` : '')
        + '</div>' : '')
      + '<div class="rl-body">';
    if (apprOpen && s.config) h += approversHtml(s);
    else if (relOpen && s.config) h += s.releaseRun ? releaseResultsHtml(s) : releasePickerHtml(s);
    const g = s.grid;
    if (s.editing || !g || s.error || s.problems) {
      h += (!g && s.loading && !s.error && !s.problems && !s.editing) ? skeletonHtml() : setupHtml(s);
    } else if (!window.ReleasesCore) {
      h += skeletonHtml();
    } else {
      // Header and footer stay put; only the board scrolls. The clicked cell's detail is a
      // drawer over the board's bottom edge, so opening it never resizes the modal.
      h += (tab === 'history' && s.config ? historyHtml(s) + '</div><div class="rl-foot">'
        + `<div class="rl-legend"><span>Releases, recorded in ${s.history && s.history.repo ? link('https://github.com/' + s.history.repo, esc(s.history.repo)) : 'release-manifests'}</span></div>`
        : envView === 'timeline' && s.config ? timelineHtml(s) + '</div><div class="rl-foot">' + TL_LEGEND : (nowFold || !s.config ? activeStrip(s) : historyHtml(s, 'now')) + gridHtml(g) + '</div>' + detailHtml(g) + '<div class="rl-foot">' + LEGEND)
        + (s.localOnly ? `<div class="rl-local" title="It isn't on GitHub yet, so teammates can't see this board. Commit and push it to share.">Local config, not pushed yet · <code>${esc(s.localOnly)}</code></div>` : '');
    }
    const prev = modal.querySelector('.rl-body'), top = prev ? prev.scrollTop : 0, left = prev ? prev.scrollLeft : 0;
    const height = modal.offsetHeight;
    modal.innerHTML = h + '</div>';
    const body = modal.querySelector('.rl-body');
    if (body) { body.scrollTop = top; body.scrollLeft = left; }
    if (body && toToday && modal.querySelector('.rl-tlx')) { body.scrollLeft = body.scrollWidth; toToday = false; }
    // keep the clicked cell visible above the drawer
    const drawer = modal.querySelector('.rl-detail'), selCell = modal.querySelector('.rl-cell.sel');
    // freeze the modal at its pre-drawer height; the drawer's room comes out of the board's scroll
    if (!drawer) modal.style.height = '';
    else if (!modal.style.height && height) modal.style.height = height + 'px';
    if (body && drawer) {
      body.style.paddingBottom = drawer.offsetHeight + 'px';
      if (selCell) {
        const over = selCell.getBoundingClientRect().bottom - drawer.getBoundingClientRect().top + 8;
        if (over > 0) body.scrollTop += over;
      }
    }
    const addInp = modal.querySelector('#rl-appr-add');
    if (addInp) addInp.onkeydown = (e) => { if (e.key === 'Enter') actions.apprAdd(); };
    const inp = modal.querySelector('#rl-src-input');
    if (inp) inp.onkeydown = (e) => { if (e.key === 'Enter') actions.saveSource(); };
  }

  // Footer badge: plain "Releases" while every deploy is fine, red "Releases · N failing" when one isn't.
  function renderBadge() {
    const failed = window.ReleasesCore && state ? ReleasesCore.failedDeploys(state.grid) : [];
    badge.classList.toggle('alert', failed.length > 0);
    const running = ((state && state.grid && state.grid.rows) || []).reduce((n, r) => n + (r.cells || []).filter(c => c && c.run && c.run.state === 'running').length, 0);
    const toSign = (state && state.toSign) || [];
    badge.classList.toggle('sign', toSign.length > 0 && !failed.length);
    const act = activeRelease(state);
    const nx = act ? releaseNext(state, act) : null;
    badge.classList.toggle('live', !!act && !toSign.length && !failed.length);
    badge.textContent = toSign.length ? `Releases · ✍ ${toSign.length} to sign` : act ? `${act.id.slice(5)} · ${nx.phase}` : 'Releases' + (failed.length ? ` · ${failed.length} failing` : '') + (running ? ` · ${running} deploying` : '');
    badge.title = act && !toSign.length ? `Release ${act.id}: ${nx.phase}${nx.next ? ' · next: ' + nx.next : ''}` : toSign.length ? `Prod release waiting for your signature: ${toSign.map(t => t.label + ' #' + t.number).join(', ')}`
      : failed.length ? `Deploy failing: ${failed.join(', ')}` : "Releases — what's merged in each environment of each repo";
  }

  // ── The big "sign this release" prompt: the moment a release waits on me, a centred window over
  // everything (the footer badge alone is easy to miss). "Later" hides it until the next new
  // thing to sign (another release, or a new commit on one). Remembered per machine.
  const signOverlay = document.createElement('div');
  signOverlay.id = 'rl-sign-overlay';
  document.body.appendChild(signOverlay);
  let promptDismissed = null;
  try { promptDismissed = localStorage.getItem('rl-sign-dismissed'); } catch {}
  signOverlay.addEventListener('click', (e) => {
    const a = e.target.closest('[data-sign]');
    const u = e.target.closest('[data-url]');
    if (u) { e.stopPropagation(); return api.send({ type: 'openUrl', url: u.dataset.url }); }
    if (!a && e.target !== signOverlay) return;
    const act = a ? a.dataset.sign : 'later';
    if (act === 'now') {
      // stays up showing "Signing…" until it's done; dismissed only if it worked (a failure brings it back)
      api.send({ type: 'releasesSign' });
      const btn = a.closest('button'); if (btn) { btn.innerHTML = '<span class="rl-spin-dot"></span>Signing…'; btn.disabled = true; }
      signWaiting = state && state.signPromptKey;
      return;
    }
    if (act === 'review') { relOpen = true; relShown = false; show(true); }
    promptDismissed = state && state.signPromptKey; // any choice closes it until something new arrives
    try { localStorage.setItem('rl-sign-dismissed', promptDismissed || ''); } catch {}
    signOverlay.classList.remove('open');
  });
  let signWaiting = null; // the prompt's key while its "Sign" runs
  function renderSignPrompt() {
    if (signWaiting) {
      if (state && state.signing) return; // still signing: leave the prompt as it is
      const left = (state && state.toSign) || [];
      if (!left.length) { promptDismissed = signWaiting; try { localStorage.setItem('rl-sign-dismissed', promptDismissed || ''); } catch {} signOverlay.classList.remove('open'); }
      signWaiting = null;
    }
    const t = (state && state.toSign) || [];
    const key = state && state.signPromptKey;
    if (!t.length || !key || key === promptDismissed) {
      // once up, it stays until you answer it (Sign / Later / Review): a refresh that briefly sees
      // nothing to sign must not make it blink away and back
      if (signOverlay.classList.contains('open') && key !== promptDismissed) return;
      signOverlay.classList.remove('open'); return;
    }
    const by = [...new Set(t.map(x => x.author).filter(Boolean))];
    setOverlay(signOverlay, '<div class="rl-sign-box" role="dialog" aria-label="Sign the release">'
      + '<div class="rl-sign-icon">✍</div>'
      + `<h2>Prod release waiting for your signature</h2>`
      + `<div class="rl-sign-sub">${by.length ? by.map(x => '@' + esc(x)).join(', ') + ' released' : 'A release is waiting'} — prod merges only once two approvers sign. One signature covers the whole release: ${esc(t[0].count)}/${esc(t[0].need)} signed so far.</div>`
      // the release, whole: every repo in it; ✓ where my signature already covers it
      + ((state.toSignReleases && state.toSignReleases.length) ? state.toSignReleases.map(r => (state.toSignReleases.length > 1 || /^\d/.test(r.id) ? `<div class="rl-sign-rel">Release ${esc(r.id)}</div>` : '')
        + '<div class="rl-sign-list">' + r.repos.map(x => `<div class="rl-sign-row${x.mine ? ' done' : ''}"><b>${esc(x.label)}</b><a data-url="${esc(x.url)}">#${esc(x.number)}</a>`
          + `<span>${x.mine ? '✓ signed' : x.older ? 'new commits since you signed' : 'needs your signature'}</span></div>`).join('') + '</div>').join('')
        : '<div class="rl-sign-list">' + t.map(x => `<div class="rl-sign-row"><b>${esc(x.label)}</b><a data-url="${esc(x.url)}">#${esc(x.number)}</a></div>`).join('') + '</div>')
      + '<div class="rl-sign-acts"><button data-sign="later">Later</button><button data-sign="review">Review first</button>'
      + `<button class="go" data-sign="now">✍ Sign the release</button></div></div>`);
  }

  // After Release all: a popup with what still goes out by hand — each row opens where to do it.
  // Shown once per finished Release all (its doneAt), remembered per machine.
  const manualOverlay = document.createElement('div');
  manualOverlay.id = 'rl-manual-overlay';
  manualOverlay.className = 'rl-overlay';
  document.body.appendChild(manualOverlay);
  let manualSeen = null;
  try { manualSeen = localStorage.getItem('rl-manual-seen'); } catch {}
  manualOverlay.addEventListener('click', (e) => {
    const u = e.target.closest('[data-url]');
    if (u) return api.send({ type: 'openUrl', url: u.dataset.url });
    const go = e.target.closest('[data-manual-go]');
    if (go) { go.textContent = 'Continuing…'; go.disabled = true; return api.send({ type: 'releasesManualDone' }); }
    if (e.target.closest('[data-confirm]') && !(state.releaseAll && state.releaseAll.running)) { showToastSafe('Recording the hand deploys…'); api.send({ type: 'releasesManualConfirm' }); }
    const stp = e.target.closest('[data-manual-stop]');
    if (stp) { stp.innerHTML = '<span class="rl-spin-dot"></span>Stopping…'; stp.disabled = true; return api.send({ type: 'releasesReleaseAllStop' }); }
    if (state.releaseAll && state.releaseAll.running) return; // a paused wave stays up until it's deployed or stopped
    if (!e.target.closest('[data-close]') && e.target !== manualOverlay) return;
    manualSeen = String(state.releaseAll.doneAt);
    try { localStorage.setItem('rl-manual-seen', manualSeen); } catch {}
    manualOverlay.classList.remove('open');
  });
  function renderManualLeft() {
    const p = state && state.releaseAll;
    // Release all paused on a hand-deployed wave: the later waves wait for these
    if (p && p.running && p.manualWave && p.manualWave.length) {
      const auto = p.manualWave.some(x => x.auto);
      setOverlay(manualOverlay, '<div class="rl-sign-box" role="dialog" aria-label="Deploy by hand">'
        + `<div class="rl-sign-icon">✋</div><h2>Wave ${esc(p.wave)}/${esc(p.waves)}: deploy these by hand first</h2>`
        + '<div class="rl-sign-sub">The next waves depend on them. Click one to open where it is deployed.'
        + (auto ? ' Release all goes on by itself once they are live.' : '') + '</div>'
        + '<div class="rl-sign-list">' + p.manualWave.map(x => `<button class="rl-sign-row rl-manual-row" data-url="${esc(x.url)}" title="${esc(x.url)}">`
          + `<b>${esc(x.label)}</b><span class="rl-env" style="--hue:${ENV_HUE[x.env.toLowerCase()] || 'var(--dim)'}">${esc(x.env)}</span>`
          + `<span>${esc(x.why)}${x.auto ? ' · watching live' : ''} ↗</span></button>`).join('') + '</div>'
        + '<div class="rl-sign-acts"><button data-manual-stop>Stop release</button><button class="go" data-manual-go>Deployed, continue</button></div></div>');
      return;
    }
    const left = p && (p.status === 'done' || p.status === 'partial') && p.manualLeft;
    if (!left || !left.length || String(p.doneAt) === manualSeen) { manualOverlay.classList.remove('open'); return; }
    setOverlay(manualOverlay, '<div class="rl-sign-box" role="dialog" aria-label="Deploy by hand">'
      + '<div class="rl-sign-icon">✋</div><h2>Released: now deploy these by hand</h2>'
      + '<div class="rl-sign-sub">Merging doesn\'t ship them: no CI deploy. Click one to open where it\'s deployed.</div>'
      + '<div class="rl-sign-list">' + left.map(x => `<button class="rl-sign-row rl-manual-row" data-url="${esc(x.url)}" title="${esc(x.url)}">`
        + `<b>${esc(x.label)}</b><span class="rl-env" style="--hue:${ENV_HUE[x.env.toLowerCase()] || 'var(--dim)'}">${esc(x.env)}</span>`
        + `<span>${esc(x.why)} ↗</span></button>`).join('') + '</div>'
      + '<div class="rl-sign-acts"><button data-close>Later</button><button class="go" data-close data-confirm title="Records each branch as deployed: the next release only asks when there is something new">Deployed ✓</button></div></div>');
  }

  // Show a popup with this HTML; rebuild it only when the HTML changed (rebuilding on every state update
  // made it flicker, and a click landing mid-rebuild hit a button that no longer existed)
  function setOverlay(el, html) {
    if (el._html !== html) { el.innerHTML = html; el._html = html; }
    el.classList.add('open');
  }

  window.releasesUi = { releaseRepos, enforcePrWatch, onMsg(msg) { state = { ...msg.state, editing: state && state.editing && !msg.state.error ? state.editing : false }; enforcePrWatch(); renderBadge(); renderSignPrompt(); renderManualLeft(); if (msg.tab) { tab = 'envs'; envView = 'board'; nowFold = false; } /* main only ever points at the release in flight */ if (msg.open && !open) show(true); render(); } };
})();
