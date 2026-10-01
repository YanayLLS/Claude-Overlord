// Renderer side of the Releases board: footer badge, modal grid, cell detail,
// setup screen. Self-contained — index.html only loads this file, its stylesheet,
// and forwards { type: 'releases' } messages to releasesUi.onMsg.
(function () {
  let state = null, open = false, sel = null; // sel = [rowIdx, cellIdx]
  let rbOpen = null, rbSkip = new Set(); // History: the release whose Rollback confirm is open, repos unticked
  let apprOpen = false; // 👥 approvers panel
  let relOpen = false, relSel = new Set(), relShown = false; // Release picker: open?, chosen envs, already animated in?
  let tab = 'board', tlEnv = '', toToday = false; // tab: 'board' | 'timeline'; tlEnv: timeline env filter, '' = all

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
  badge.onclick = (e) => { e.stopPropagation(); show(true); };
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
    if (armed && !e.target.closest('[data-act="relMerge"], [data-act="histMerge"], [data-act="relCancel"]')) { armed = null; render(); }
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
      relOpen = true; relShown = false;
      // your last choice sticks (a hover-close + reopen must never re-tick an env you unticked);
      // only the very first time does it start with every env picked
      if (state && state.config) {
        const targets = ReleasesCore.releaseTargets(state.config);
        let saved = null;
        try { saved = JSON.parse(localStorage.getItem('rl-release-envs') || 'null'); } catch {}
        relSel = new Set(Array.isArray(saved) ? saved.filter(e => targets.includes(e)) : targets);
      }
      render();
    },
    releaseClose: () => { relOpen = false; render(); },
    apprMenu: () => { apprOpen = !apprOpen; relOpen = false; if (apprOpen) api.send({ type: 'releasesApprovers' }); render(); },
    apprAdd: () => {
      const inp = modal.querySelector('#rl-appr-add');
      const login = inp && inp.value.trim().replace(/^@/, '');
      if (login) api.send({ type: 'releasesApproversEdit', kind: 'add', login });
    },
    apprRemove: (el) => { api.send({ type: 'releasesApproversEdit', kind: 'remove', login: el.dataset.login }); },
    apprCreate: () => { api.send({ type: 'releasesApproversEdit', kind: 'create' }); },
    relSign: () => { api.send({ type: 'releasesSign' }); },
    // Release all merges to prod: the first click arms it (the button asks to confirm), a second within ARM_MS starts it
    relMerge: () => { if (armed !== 'run') return arm('run'); armed = null; api.send({ type: 'releasesMerge' }); render(); },
    relAllStop: () => { api.send({ type: 'releasesReleaseAllStop' }); },
    relAllResume: (el) => { api.send(el.dataset.id ? { type: 'releasesMergeRelease', id: el.dataset.id } : { type: 'releasesMerge' }); },
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
      try { localStorage.setItem('rl-release-envs', JSON.stringify([...relSel])); } catch {}
      render();
    },
    releaseGo: () => {
      if (!relSel.size) return;
      // runs in main without an agent; the panel turns into its live results
      api.send({ type: 'releasesRelease', envs: [...relSel] });
    },
    // Fix on a blocked row: an agent for that repo only — leave the modal to land on it
    // one agent for every blocked row — leave the modal to land on it
    fixDeploy: (el) => { api.send({ type: 'releasesFixDeploy', key: el.dataset.key }); show(false); },
    // el.dataset.i = one row's Fix; none = Fix all
    relFix: (el) => { const i = el && el.dataset.i != null ? +el.dataset.i : undefined; api.send({ type: 'releasesFix', i }); relOpen = false; show(false); },
    relNew: () => { api.send({ type: 'releasesClearRun' }); },
    tab: (el) => { tab = el.dataset.tab; sel = null; toToday = tab === 'timeline'; if (tab === 'history') api.send({ type: 'releasesHistory' }); render(); },
    // history actions
    histRollback: (el) => { rbOpen = rbOpen === el.dataset.id ? null : el.dataset.id; rbSkip = new Set(); render(); },
    histRbRepo: (el) => { const r = el.dataset.repo; rbSkip.has(r) ? rbSkip.delete(r) : rbSkip.add(r); render(); },
    histRbGo: (el) => { api.send({ type: 'releasesRollback', id: el.dataset.id, skip: [...rbSkip] }); rbOpen = null; render(); },
    // Cancel release: closes every open PR of it. Same two-click confirm as Release all
    relCancel: (el) => { const k = 'x:' + (el.dataset.id || 'run'); if (armed !== k) return arm(k); armed = null; api.send({ type: 'releasesCancel', id: el.dataset.id || null }); render(); },
    histMerge: (el) => { if (armed !== 'h:' + el.dataset.id) return arm('h:' + el.dataset.id); armed = null; api.send({ type: 'releasesMergeRelease', id: el.dataset.id }); render(); },
    histReload: () => { api.send({ type: 'releasesHistory' }); },
    histImport: () => { api.send({ type: 'releasesImport' }); },
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
    for (const n of c.nexts || []) {
      if (n.loading || n.error) continue;
      if (!n.ahead) { h += `<div style="margin-top:6px">Nothing waiting for ${esc(n.to)}.</div>`; continue; }
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
    return armed === k
      ? `<button class="${cls} armed-bad" data-act="relCancel"${id ? ` data-id="${esc(id)}"` : ''}>⚠ Confirm: close ${n} PR${n === 1 ? '' : 's'}</button>`
      : `<button class="${cls}" data-act="relCancel"${id ? ` data-id="${esc(id)}"` : ''} title="Call this release off: closes its ${n} open PR${n === 1 ? '' : 's'} (with a note). Merged ones stay merged">✕ Cancel release</button>`;
  }
  let armed = null, armTimer = null;
  const ARM_MS = 6000;
  function arm(key) {
    armed = key; clearTimeout(armTimer);
    armTimer = setTimeout(() => { armed = null; render(); }, ARM_MS);
    render();
  }
  function releaseAllBtn(s, { ready, waiting, signoff, attrs, lockedCls, armKey }) {
    if (s.releaseAll && s.releaseAll.running) return '';
    // one Release all across the team: someone else's is running
    if (s.teamRun) return `<button class="${lockedCls} locked" aria-disabled="true" title="${esc(`@${s.teamRun.by} is running Release all: wave ${s.teamRun.wave}/${s.teamRun.waves}, ${s.teamRun.status}${s.teamRun.detail ? ' (' + s.teamRun.detail + ')' : ''}${(s.teamRun.merged || []).length ? '\nmerged: ' + s.teamRun.merged.join(', ') : ''}`)}">🚀 Running on @${esc(s.teamRun.by)}'s Overlord · wave ${esc(s.teamRun.wave)}/${esc(s.teamRun.waves)}</button>`;
    const so = signoff || { count: 0, need: 2, signers: [], gaps: [] };
    const signedLine = `the prod release is signed ${so.count}/${so.need}${so.signers.length ? ' (' + so.signers.map(l => '@' + l).join(', ') + ')' : ''}`;
    const gapLines = (so.gaps || []).map(g => `\n@${g.login} still to sign: ${g.missing.map(x => x.label + (x.older ? ' (new commits)' : '')).join(', ')}`).join('');
    const pr = (r) => `• ${r.label} ${r.env || 'prod'}${r.pr ? ' #' + r.pr.number : ''}`;
    if (!ready.length) return waiting.length
      ? `<button class="${lockedCls} locked" aria-disabled="true" title="${esc(`Can't merge yet: ${signedLine}.${gapLines}`)}">🔒 Release all · needs signatures</button>` : '';
    const byEnv = {};
    for (const r of ready) byEnv[r.env || 'prod'] = (byEnv[r.env || 'prod'] || 0) + 1;
    const tip = `${Object.entries(byEnv).map(([e, n]) => `${n} ${e}`).join(' + ')}. Merges now, in release order (services → iframes → frontend), waiting for each wave's deploys; stops on a failed deploy:\n`
      + ready.map(pr).join('\n') + (waiting.length ? `\n\nHeld back: ${signedLine}:\n${waiting.map(pr).join('\n')}${gapLines}` : '');
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
    const head = p.running ? `🚀 Wave ${p.wave}/${p.waves} · ${p.status === 'deploying' ? 'waiting for deploys' : p.status === 'manual' ? 'deploy by hand' : 'merging'}: ${esc(p.detail || '')}`
      : p.status === 'done' ? `🚀 Released: ${esc(p.detail || 'every wave merged')} ✓`
      : p.status === 'interrupted' ? `⏸ Release all interrupted: Overlord closed at wave ${esc(p.wave)}/${esc(p.waves)}`
      : `⏸ Release all stopped: ${p.url ? link(p.url, esc(p.detail || '')) : esc(p.detail || '')}`;
    return `<div class="rl-relall ${p.running ? 'running' : p.status === 'done' ? 'ok' : 'bad'}"><span>${head}</span>`
      + (p.merged && p.merged.length ? `<span class="rl-relall-merged">merged: ${esc(p.merged.join(', '))}</span>` : '')
      + (p.status === 'interrupted' ? `<button class="rl-hist-btn go" data-act="relAllResume" data-id="${esc(p.id || '')}" title="Picks up with what is still open: merged PRs are skipped, a deploy still running is waited on first">▶ Resume</button>` : '')
      + (p.running ? '<button class="rl-hist-btn" data-act="relAllStop" title="Stops before the next merge. What already merged stays merged">⏹ Stop</button>' : '') + '</div>';
  }

  // ── History: every prod release from <org>/release-manifests, the pending one first ──
  const STATUS_CHIP = { pending: ['warn', 'pending'], merged: ['', 'merged · deploying'], deployed: ['ok', 'deployed ✓'],
    'deploy-failed': ['bad', 'deploy failed'], abandoned: ['', 'abandoned'] };
  const shortSha = (x) => x ? esc(x.slice(0, 7)) : '—';
  function historyHtml(s) {
    const hs = s.history;
    let h = '<div class="rl-hist">' + releaseAllHtml(s);
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
    for (const m of hs.items) {
      const [cls, label] = STATUS_CHIP[m.status] || ['', m.status];
      const pending = m.status === 'pending';
      // signed as one: while pending, a signer is someone on every still-open PR
      const openRepos = m.repos.filter(r => !r.mergeSha && !r.closed);
      const anyone = [...new Set(m.repos.flatMap(r => r.signers || []))];
      const signers = pending && openRepos.length ? anyone.filter(l => openRepos.every(r => (r.signers || []).includes(l))) : anyone;
      h += `<div class="rl-hist-card${pending ? ' pending' : ''}"><div class="rl-hist-top">`
        + `<b>${m.kind === 'rollback' ? '↩ Rollback' : 'Release'} ${esc(m.id)}</b>`
        + (m.kind === 'rollback' ? `<span class="rl-rr-chip">restores ${esc(m.rollbackOf)}</span>` : '')
        + (m.imported ? '<span class="rl-rr-chip" title="Built from merged release PRs, before release manifests existed">imported</span>' : '')
        + (!m.imported && m.repos.some(r => r.unsigned) ? `<span class="rl-rr-chip bad" title="Merged with fewer than 2 approvers' signatures (e.g. on github.com): ${esc(m.repos.filter(r => r.unsigned).map(r => r.label).join(', '))}">merged unsigned ⚠</span>` : '')
        + `<span class="rl-rr-chip ${cls}">${esc(label)}</span>`
        + (pending ? `<span class="rl-rr-chip ${signers.length >= 2 ? 'ok' : 'warn'}" title="The release is signed as one: a signature counts once it covers every open PR of it, and stays as more commits merge in">✍ ${signers.length}/2 signed</span>` : '')
        + `<span class="rl-hist-when" title="${esc(m.openedAt)}">${age(m.openedAt) === 'now' ? 'just now' : esc(age(m.openedAt)) + ' ago'}</span></div>`
        + `<div class="rl-hist-who">Opened by ${m.openedBy ? '@' + esc(m.openedBy.login) : '?'}${signers.length ? ' · signed by ' + signers.map(x => '@' + esc(x)).join(', ') : ''}</div>`;
      h += '<div class="rl-hist-repos">';
      for (const r of m.repos) {
        const need = pending && !r.mergeSha && !r.closed;
        const signed = (r.signers || []).length;
        const cmp = r.baseSha && (r.mergeSha || r.headSha) ? `https://github.com/${r.repo}/compare/${r.baseSha}...${r.mergeSha || r.headSha}` : null;
        const dep = r.deploy ? (r.deploy.state === 'success' ? '<span class="ok">deployed</span>' : r.deploy.state === 'failure' ? '<span class="bad">deploy failed</span>' : r.mergeSha ? 'deploying…' : '') : '✋ by hand';
        h += `<div class="rl-hist-repo"><b>${esc(r.label)}</b>${link(r.pr.url, '#' + r.pr.number)}`
          + `<span class="rl-hist-sha" title="prod before → after">${cmp ? link(cmp, shortSha(r.baseSha) + ' → ' + shortSha(r.mergeSha || r.headSha)) : ''}</span>`
          + (need && r.health ? histHealth(r.health) : '')
          + `<span class="rl-hist-state">${r.closed && !r.mergeSha ? 'closed' : need ? (() => { const miss = signers.length >= 2 ? [] : anyone.filter(l => !(r.signers || []).includes(l)); return miss.length ? `<span class="warn" title="Signed the rest of the release but not this PR's latest commit">✍ needs ${miss.map(l => '@' + esc(l)).join(', ')}</span>` : '✍ ✓'; })() + (toSign.has(r.repo + '#' + r.pr.number) ? ' · needs you' : '') : r.mergeSha ? dep : ''}</span></div>`;
      }
      h += '</div>';
      if (m.manual && m.manual.length) h += `<div class="rl-hist-man">Hand-deployed at the time: ${m.manual.map(x => esc(x.label) + (x.live && x.live.sha ? ' ' + shortSha(x.live.sha) : '')).join(' · ')}</div>`;
      if (m.warnings && m.warnings.length) h += `<div class="rl-hist-man bad">⚠ Not rolled back (data changes): ${m.warnings.map(w => esc(w.label) + ': ' + w.files.map(esc).join(', ')).join(' · ')}</div>`;
      if (m.flags && m.flags.missing && m.flags.missing.length) h += `<div class="rl-hist-man bad">Flags to seed: ${esc(m.flags.missing.join(', '))}</div>`;
      // actions
      const acts = [];
      if (pending && a.isApprover && m.repos.some(r => toSign.has(r.repo + '#' + r.pr.number))) acts.push(signBtn(s, 'rl-hist-btn go', '✍ Sign'));
      if (pending && a.isApprover) acts.push(releaseAllBtn(s, {
        ready: signers.length >= 2 ? openRepos : [],
        waiting: signers.length >= 2 ? [] : openRepos,
        signoff: { count: signers.length, need: 2, signers, gaps: anyone.filter(l => !signers.includes(l))
          .map(login => ({ login, missing: openRepos.filter(r => !(r.signers || []).includes(login)).map(r => ({ label: r.label })) })) },
        attrs: `class="rl-hist-btn" data-act="histMerge" data-id="${esc(m.id)}"`, lockedCls: 'rl-hist-btn', armKey: 'h:' + m.id }));
      if (pending && a.isApprover && openRepos.length && !(s.releaseAll && s.releaseAll.running)) acts.push(cancelBtn(m.id, openRepos.length, 'rl-hist-btn'));
      if (!pending && m.status !== 'abandoned' && m.repos.some(r => r.mergeSha) && a.isApprover) {
        acts.push(`<button class="rl-hist-btn${rbOpen === m.id ? ' on' : ''}" data-act="histRollback" data-id="${esc(m.id)}">↩ Roll back to this</button>`);
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
    }
    return h + '</div>';
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
    if (quiet.length) h += `<div class="rl-rr-sub">Nothing to release: ${quiet.map(r => esc(r.label) + (r.closed ? ` ${esc(r.env)} (PR closed)` : '')).join(' · ')}</div>`;
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
    h += releaseAllHtml(s) + '<div class="rl-rel-actions">'
      + (toSign ? signBtn(s, 'rl-rr-sign', '✍ Sign the release', `Approve every prod release PR as @${a.me}: your signature`) : '')
      + releaseAllBtn(s, { ready: readyRows, waiting: unsignedProd, signoff: run.signoff && { ...run.signoff, signers: run.signoff.signers.map(x => x.login) },
        attrs: 'class="rl-rr-merge" data-act="relMerge"', lockedCls: 'rl-rr-merge', armKey: 'run' })
      + (open.length && (s.approvers || {}).isApprover && !(s.releaseAll && s.releaseAll.running) ? cancelBtn('', open.length, 'rl-rr-cancel') : '')
      + (blocked ? `<button class="rl-rr-fix" data-act="relFix" title="One agent unblocks every blocked row">🔧 Fix all (${blocked})</button>` : '')
      // a new release only once this one's PRs are all merged or closed (Release again just reuses open PRs anyway)
      + (run.running || open.length ? '' : '<button data-act="relNew">New release</button>')
      + '<button data-act="releaseClose">Close</button></div></div>';
    return h;
  }

  // Repos in the release config the PRs panel doesn't watch yet; null when that panel is off.
  // prSettings is index.html's (a shared global), refreshed whenever main echoes the settings.
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
    const plan = ReleasesCore.releasePlan(cfg, [...relSel]);
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
    h += '</div><div class="rl-rel-sum">' + (relSel.size
      ? `${plan.prs.length} release PR${plan.prs.length === 1 ? '' : 's'} to check and open`
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

  function render() {
    tlTip.classList.remove('show');
    if (!open) return;
    const s = state || { source: '', loading: true };
    const upd = s.updatedAt ? `updated ${new Date(s.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
    let h = '<div class="rl-head"><h2>Releases</h2>'
      + (s.grid ? `<div class="rl-tabs"><button data-act="tab" data-tab="board" class="${tab === 'board' ? 'on' : ''}">Board</button>`
        + `<button data-act="tab" data-tab="timeline" class="${tab === 'timeline' ? 'on' : ''}">Timeline</button>`
        + `<button data-act="tab" data-tab="history" class="${tab === 'history' ? 'on' : ''}">History</button></div>` : '')
      + `<span class="rl-src" data-act="editSource" title="Change config source">${esc(s.source)}</span>`
      + `<span class="rl-upd">${s.loading ? 'loading…' : esc(upd)}</span>`
      + (s.config ? `<button class="rl-appr-btn${apprOpen ? ' on' : ''}" data-act="apprMenu" title="Release approvers: releasing and merging prod needs two of them"><svg class="ic" viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`
        + `<span>${s.approvers && s.approvers.members ? s.approvers.members.length : ''}</span></button>` : '')
      + (s.config && window.ReleasesCore && ReleasesCore.releaseTargets(s.config).length
        // everyone can open the picker (what's waiting, the PR-watch bell); only Start release is for approvers
        ? `<button class="rl-release${relOpen ? ' on' : ''}" data-act="releaseMenu" title="What's waiting to release, per env">`
          + '<svg class="ic" viewBox="0 0 24 24"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>Release</button>'
        : '')
      + `<button data-act="refresh" class="${s.loading ? 'spin' : ''}" title="Refresh"><svg class="ic" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/></svg></button>`
      + '<button data-act="close" title="Close (Esc)"><svg class="ic" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div><div class="rl-body">';
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
        + `<div class="rl-legend"><span>Prod releases, recorded in ${s.history && s.history.repo ? link('https://github.com/' + s.history.repo, esc(s.history.repo)) : 'release-manifests'}</span></div>`
        : tab === 'timeline' && s.config ? timelineHtml(s) + '</div><div class="rl-foot">' + TL_LEGEND : gridHtml(g) + '</div>' + detailHtml(g) + '<div class="rl-foot">' + LEGEND)
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
    badge.textContent = 'Releases' + (toSign.length ? ` · ✍ ${toSign.length} to sign` : '') + (failed.length ? ` · ${failed.length} failing` : '') + (running ? ` · ${running} deploying` : '');
    badge.title = toSign.length ? `Prod release waiting for your signature: ${toSign.map(t => t.label + ' #' + t.number).join(', ')}`
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
    if (act === 'now') api.send({ type: 'releasesSign' });
    if (act === 'review') { relOpen = true; relShown = false; show(true); }
    promptDismissed = state && state.signPromptKey; // any choice closes it until something new arrives
    try { localStorage.setItem('rl-sign-dismissed', promptDismissed || ''); } catch {}
    signOverlay.classList.remove('open');
  });
  function renderSignPrompt() {
    const t = (state && state.toSign) || [];
    const key = state && state.signPromptKey;
    if (!t.length || !key || key === promptDismissed) { signOverlay.classList.remove('open'); return; }
    const by = [...new Set(t.map(x => x.author).filter(Boolean))];
    signOverlay.innerHTML = '<div class="rl-sign-box" role="dialog" aria-label="Sign the release">'
      + '<div class="rl-sign-icon">✍</div>'
      + `<h2>Prod release waiting for your signature</h2>`
      + `<div class="rl-sign-sub">${by.length ? by.map(x => '@' + esc(x)).join(', ') + ' released' : 'A release is waiting'} — prod merges only once two approvers sign. One signature covers the whole release: ${esc(t[0].count)}/${esc(t[0].need)} signed so far.</div>`
      // the release, whole: every repo in it; ✓ where my signature already covers it
      + ((state.toSignReleases && state.toSignReleases.length) ? state.toSignReleases.map(r => (state.toSignReleases.length > 1 || /^\d/.test(r.id) ? `<div class="rl-sign-rel">Release ${esc(r.id)}</div>` : '')
        + '<div class="rl-sign-list">' + r.repos.map(x => `<div class="rl-sign-row${x.mine ? ' done' : ''}"><b>${esc(x.label)}</b><a data-url="${esc(x.url)}">#${esc(x.number)}</a>`
          + `<span>${x.mine ? '✓ signed' : x.older ? 'new commits since you signed' : 'needs your signature'}</span></div>`).join('') + '</div>').join('')
        : '<div class="rl-sign-list">' + t.map(x => `<div class="rl-sign-row"><b>${esc(x.label)}</b><a data-url="${esc(x.url)}">#${esc(x.number)}</a></div>`).join('') + '</div>')
      + '<div class="rl-sign-acts"><button data-sign="later">Later</button><button data-sign="review">Review first</button>'
      + `<button class="go" data-sign="now">✍ Sign the release</button></div></div>`;
    signOverlay.classList.add('open');
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
    if (e.target.closest('[data-manual-go]')) return api.send({ type: 'releasesManualDone' });
    if (e.target.closest('[data-confirm]') && !(state.releaseAll && state.releaseAll.running)) api.send({ type: 'releasesManualConfirm' });
    if (e.target.closest('[data-manual-stop]')) return api.send({ type: 'releasesReleaseAllStop' });
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
      manualOverlay.innerHTML = '<div class="rl-sign-box" role="dialog" aria-label="Deploy by hand">'
        + `<div class="rl-sign-icon">✋</div><h2>Wave ${esc(p.wave)}/${esc(p.waves)}: deploy these by hand first</h2>`
        + '<div class="rl-sign-sub">The next waves depend on them. Click one to open where it is deployed.'
        + (auto ? ' Release all goes on by itself once they are live.' : '') + '</div>'
        + '<div class="rl-sign-list">' + p.manualWave.map(x => `<button class="rl-sign-row rl-manual-row" data-url="${esc(x.url)}" title="${esc(x.url)}">`
          + `<b>${esc(x.label)}</b><span class="rl-env" style="--hue:${ENV_HUE[x.env.toLowerCase()] || 'var(--dim)'}">${esc(x.env)}</span>`
          + `<span>${esc(x.why)}${x.auto ? ' · watching live' : ''} ↗</span></button>`).join('') + '</div>'
        + '<div class="rl-sign-acts"><button data-manual-stop>Stop release</button><button class="go" data-manual-go>Deployed, continue</button></div></div>';
      manualOverlay.classList.add('open');
      return;
    }
    const left = p && p.status === 'done' && p.manualLeft;
    if (!left || !left.length || String(p.doneAt) === manualSeen) { manualOverlay.classList.remove('open'); return; }
    manualOverlay.innerHTML = '<div class="rl-sign-box" role="dialog" aria-label="Deploy by hand">'
      + '<div class="rl-sign-icon">✋</div><h2>Released: now deploy these by hand</h2>'
      + '<div class="rl-sign-sub">Merging doesn\'t ship them: no CI deploy. Click one to open where it\'s deployed.</div>'
      + '<div class="rl-sign-list">' + left.map(x => `<button class="rl-sign-row rl-manual-row" data-url="${esc(x.url)}" title="${esc(x.url)}">`
        + `<b>${esc(x.label)}</b><span class="rl-env" style="--hue:${ENV_HUE[x.env.toLowerCase()] || 'var(--dim)'}">${esc(x.env)}</span>`
        + `<span>${esc(x.why)} ↗</span></button>`).join('') + '</div>'
      + '<div class="rl-sign-acts"><button data-close>Later</button><button class="go" data-close data-confirm title="Records each branch as deployed: the next release only asks when there is something new">Deployed ✓</button></div></div>';
    manualOverlay.classList.add('open');
  }

  window.releasesUi = { onMsg(msg) { state = { ...msg.state, editing: state && state.editing && !msg.state.error ? state.editing : false }; renderBadge(); renderSignPrompt(); renderManualLeft(); if (msg.open && !open) show(true); render(); } };
})();
