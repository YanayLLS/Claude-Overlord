// Renderer side of the Releases board: footer badge, modal grid, cell detail,
// setup screen. Self-contained — index.html only loads this file, its stylesheet,
// and forwards { type: 'releases' } messages to releasesUi.onMsg.
(function () {
  let state = null, open = false, sel = null; // sel = [rowIdx, cellIdx]
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
    if (sel) { sel = null; render(); } else show(false);
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
    tab: (el) => { tab = el.dataset.tab; sel = null; toToday = tab === 'timeline'; render(); },
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
      return { cls: 'ok', manual, url: c.live.behind ? c.live.compareUrl : c.live.url,
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
      return `<div class="rl-uses" title="${esc(c.env)} has no deployment of its own for this repo — it uses ${esc(c.uses)}'s">`
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
    if (c.live && c.live.behind) next = `<span class="rl-next" title="${c.live.behind} commits on ${esc(c.branch)} not deployed">${link(c.live.compareUrl, `<b>${c.live.behind}</b> not live`)}</span>`;
    // one count per step out of this env — a fork (dev → alpha, dev → prod) shows both
    else next = (c.nexts || []).map((n, k) => {
      const lead = k ? ' rl-next-more' : '';
      if (n.loading) return `<span class="rl-next zero${lead}">… ${esc(n.to)}</span>`;
      if (n.error) return `<span class="rl-next rl-bad${lead}" title="${esc(n.error)}">? ${esc(n.to)}</span>`;
      if (!n.ahead) return `<span class="rl-next zero${lead}" title="Nothing waiting for ${esc(n.to)}">✓ ${esc(n.to)}</span>`;
      return `<span class="rl-next${lead}" title="${n.ahead} commits not yet in ${esc(n.to)}">${link(n.url, `<b>${n.ahead}</b> → ${esc(n.to)}`)}</span>`;
    }).join('');
    const hand = d.manual ? '<svg class="rl-hand" viewBox="0 0 24 24" aria-label="manual deploy"><path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>' : '';
    const tip = [d.text, shown && shown.title,
      [c.branch, shown && shown.sha.slice(0, 7), c.commit && c.commit.author].filter(Boolean).join(' · ')].filter(Boolean).join('\n');
    const isSel = sel && sel[0] === r && sel[1] === i;
    return `<div class="rl-cell st-${d.cls}${isSel ? ' sel' : ''}" data-r="${r}" data-c="${i}" title="${esc(tip)}" data-tip-dot="rl-dot ${d.cls}"><div class="rl-top">${hand}${top}${next}</div></div>`;
  }

  const ENV_HUE = { dev: 'var(--accent)', alpha: 'var(--purple)', staging: 'var(--yellow)', prod: 'var(--green)', production: 'var(--green)' };
  const HUES = ['var(--accent)', 'var(--purple)', 'var(--cyan)', 'var(--yellow)', 'var(--green)'];

  const hueOf = (env, envs) => ENV_HUE[env.toLowerCase()] || HUES[envs.indexOf(env) % HUES.length];

  // Timeline tab, ClickUp-style: days run left→right, one lane per repo·env, each landing on that
  // env's branch is a pill at its moment. Same data the board's second pass already fetched —
  // no extra calls. Pills too close to their neighbour shrink to dots (hover for the rest).
  const DAY_MS = 864e5, DAY_W = 64, MAX_DAYS = 30, MIN_DAYS = 7;
  function timelineHtml(s) {
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
        const x = xOf(Date.parse(e.date));
        const when = new Date(e.date).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
        // deploy runs: when it went out, by whom, did it work. merges: hand-deployed envs, go-live time unknown
        const what = e.kind === 'merge' ? 'merged · deployed by hand, go-live time unknown'
          : e.state === 'success' ? `deployed${e.actor ? ' by ' + e.actor : ''}`
          : e.state === 'partial' ? `deployed${e.actor ? ' by ' + e.actor : ''} · a follow-up job failed`
          : `deploy ${e.state === 'failure' ? 'FAILED' : e.state}${e.actor ? ' · ' + e.actor : ''}`;
        const kind = e.kind === 'merge' ? ' merge' : e.state === 'failure' ? ' fail' : e.state === 'partial' ? ' part' : '';
        h += `<a class="rl-tlx-mark${kind}" data-url="${esc(e.url)}" style="left:${x}px; --hue:${hueOf(e.env, envs)}"`
          + ` title="${esc(e.env.toUpperCase())} ${esc(what)} · ${esc(when)}\n${esc(refOf(e))} ${esc(e.title.replace(/^#\d+ /, ''))}\n${esc(e.branch)} · ${esc(e.sha.slice(0, 7))}">`
          + '</a>';
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
    + '<span><svg class="rl-hand" viewBox="0 0 24 24"><path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>manual deploy</span>'
    + '<span><span class="rl-next"><b>12</b> → prod</span>waiting to promote</span></div>';

  function detailHtml(grid) {
    const row = sel && grid.rows[sel[0]];
    const c = row && row.cells && row.cells[sel[1]];
    if (!c) return '';
    let h = `<div class="rl-detail"><button class="rl-x" data-act="deselect" title="Close"><svg class="ic" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg></button>`
      + `<h3>${esc(row.label)} · ${esc(c.env)} <span class="rl-mono">(${esc(c.branch)})</span></h3>`;
    const d = deployInfo(c);
    h += `<div class="rl-dep-line"><i class="rl-dot ${d.cls}"></i>${d.url ? link(d.url, esc(d.text)) : esc(d.text)}</div>`;
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

  function render() {
    if (!open) return;
    const s = state || { source: '', loading: true };
    const upd = s.updatedAt ? `updated ${new Date(s.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
    let h = '<div class="rl-head"><h2>Releases</h2>'
      + (s.grid ? `<div class="rl-tabs"><button data-act="tab" data-tab="board" class="${tab === 'board' ? 'on' : ''}">Board</button>`
        + `<button data-act="tab" data-tab="timeline" class="${tab === 'timeline' ? 'on' : ''}">Timeline</button></div>` : '')
      + `<span class="rl-src" data-act="editSource" title="Change config source">${esc(s.source)}</span>`
      + `<span class="rl-upd">${s.loading ? 'loading…' : esc(upd)}</span>`
      + `<button data-act="refresh" class="${s.loading ? 'spin' : ''}" title="Refresh"><svg class="ic" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/></svg></button>`
      + '<button data-act="close" title="Close (Esc)"><svg class="ic" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div><div class="rl-body">';
    const g = s.grid;
    if (s.editing || !g || s.error || s.problems) {
      h += (!g && s.loading && !s.error && !s.problems && !s.editing) ? skeletonHtml() : setupHtml(s);
    } else if (!window.ReleasesCore) {
      h += skeletonHtml();
    } else {
      // Header and footer stay put; only the board scrolls. The clicked cell's detail is a
      // drawer over the board's bottom edge, so opening it never resizes the modal.
      h += (tab === 'timeline' && s.config ? timelineHtml(s) + '</div><div class="rl-foot">' + TL_LEGEND : gridHtml(g) + '</div>' + detailHtml(g) + '<div class="rl-foot">' + LEGEND)
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
    const inp = modal.querySelector('#rl-src-input');
    if (inp) inp.onkeydown = (e) => { if (e.key === 'Enter') actions.saveSource(); };
  }

  // Footer badge: plain "Releases" while every deploy is fine, red "Releases · N failing" when one isn't.
  function renderBadge() {
    const failed = window.ReleasesCore && state ? ReleasesCore.failedDeploys(state.grid) : [];
    badge.classList.toggle('alert', failed.length > 0);
    badge.textContent = failed.length ? `Releases · ${failed.length} failing` : 'Releases';
    badge.title = failed.length ? `Deploy failing: ${failed.join(', ')}` : "Releases — what's merged in each environment of each repo";
  }

  window.releasesUi = { onMsg(msg) { state = { ...msg.state, editing: state && state.editing && !msg.state.error ? state.editing : false }; renderBadge(); render(); } };
})();
