// Renderer side of the Releases board: footer badge, modal grid, cell detail,
// setup screen. Self-contained — index.html only loads this file, its stylesheet,
// and forwards { type: 'releases' } messages to releasesUi.onMsg.
(function () {
  let state = null, open = false, sel = null; // sel = [rowIdx, cellIdx]

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
  // Dot colour + a short label; the tooltip shows the same dot as a badge beside the label.
  const DOT = { success: ['ok', 'Deployed'], failure: ['bad', 'Deploy failed'], partial: ['part', 'Deployed · a follow-up job failed'],
    running: ['run', 'Deploying now'], cancelled: ['off', 'Deploy cancelled'], never: ['off', 'Never deployed'] };
  function deployInfo(c) {
    if (c.deploy === 'manual') return { cls: 'manual', text: 'Manual deploy · no CI/CD · this tip may not be live yet' };
    if (!c.deploy) return { cls: 'none', text: 'No deploy workflow' };
    if (!c.run) return { cls: 'off', text: 'Deploy status loading…' };
    const [cls, label] = DOT[c.run.state] || ['off', `Deploy ${c.run.state}`];
    // name what broke, e.g. "technical-pr-to-dev › Open (or reuse) the staging → dev technical PR"
    const why = (c.run.failed || []).map(f => f.job + (f.step ? ` › ${f.step}` : '')).join('; ');
    return { cls, url: c.run.url, text: label + (c.run.date && c.run.state !== 'running' ? ` · ${age(c.run.date)} ago` : '') + (why ? ` · ${why}` : '') };
  }
  function dotHtml(c) {
    const d = deployInfo(c), attrs = `title="${esc(d.text)}" data-tip-dot="rl-dot ${d.cls}"`;
    return d.url ? `<a class="rl-dot ${d.cls}" data-url="${esc(d.url)}" ${attrs}></a>` : `<span class="rl-dot ${d.cls}" ${attrs}></span>`;
  }

  function cellHtml(c, r, i) {
    if (!c) return '<div class="rl-empty"></div>';
    let top;
    if (c.loading) top = '<span class="rl-age">loading…</span>';
    else if (c.missing) top = '<span class="rl-bad">branch missing</span>';
    else if (c.error) top = `<span class="rl-bad" title="${esc(c.error)}">! error</span>`;
    else {
      // PR number when the tip is a merge ("#933 fix: …"), else the short sha; the title lives in the tooltip
      const pr = (c.commit.title.match(/^#(\d+) /) || [])[1];
      top = `<span class="rl-sha">${pr ? '#' + pr : esc(c.commit.sha.slice(0, 7))}</span><span class="rl-age">${esc(age(c.commit.date))}</span>`;
    }
    let next = '';
    if (c.next) {
      const n = c.next;
      if (n.loading) next = `<span class="rl-next zero">… ${esc(n.to)}</span>`;
      else if (n.error) next = `<span class="rl-next rl-bad" title="${esc(n.error)}">? ${esc(n.to)}</span>`;
      else if (!n.ahead) next = `<span class="rl-next zero" title="Nothing waiting for ${esc(n.to)}">✓ ${esc(n.to)}</span>`;
      else next = `<span class="rl-next" title="${n.ahead} commits not yet in ${esc(n.to)}">${link(n.url, `<b>${n.ahead}</b> → ${esc(n.to)}`)}</span>`;
    }
    const tip = [deployInfo(c).text, c.commit && c.commit.title,
      [c.branch, c.commit && c.commit.sha.slice(0, 7), c.commit && c.commit.author].filter(Boolean).join(' · ')].filter(Boolean).join('\n');
    const isSel = sel && sel[0] === r && sel[1] === i;
    return `<div class="rl-cell${isSel ? ' sel' : ''}" data-r="${r}" data-c="${i}" title="${esc(tip)}" data-tip-dot="rl-dot ${deployInfo(c).cls}"><div class="rl-top">${dotHtml(c)}${top}${next}</div></div>`;
  }

  const ENV_HUE = { dev: 'var(--accent)', alpha: 'var(--purple)', staging: 'var(--yellow)', prod: 'var(--green)', production: 'var(--green)' };
  const HUES = ['var(--accent)', 'var(--purple)', 'var(--cyan)', 'var(--yellow)', 'var(--green)'];

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
    + '<span><i class="rl-dot ok"></i>deployed</span>'
    + '<span><i class="rl-dot bad"></i>deploy failed</span>'
    + '<span><i class="rl-dot part"></i>deployed, side job failed</span>'
    + '<span><i class="rl-dot run"></i>deploying</span>'
    + '<span><i class="rl-dot manual"></i>manual deploy</span>'
    + '<span><span class="rl-next"><b>12</b> → prod</span>waiting to promote</span></div>';

  function detailHtml(grid) {
    const row = sel && grid.rows[sel[0]];
    const c = row && row.cells && row.cells[sel[1]];
    if (!c) return '';
    let h = `<div class="rl-detail"><button class="rl-x" data-act="deselect" title="Close"><svg class="ic" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg></button>`
      + `<h3>${esc(row.label)} · ${esc(c.env)} <span class="rl-mono">(${esc(c.branch)})</span></h3>`;
    if (c.commit) {
      h += `<div>${link(c.commit.url, `<span class="rl-mono">${esc(c.commit.sha.slice(0, 7))}</span> ${esc(c.commit.title)}`)}`
        + ` — ${esc(c.commit.author)}, ${esc(age(c.commit.date))} ago</div>`;
    }
    const n = c.next;
    if (n && !n.loading && !n.error) {
      if (!n.ahead) h += `<div style="margin-top:6px">Nothing waiting for ${esc(n.to)}.</div>`;
      else {
        h += `<div style="margin-top:6px">${n.ahead} commit${n.ahead === 1 ? '' : 's'} not yet in ${esc(n.to)} (newest first):</div><ul>`;
        if (!n.commits) h += '<li class="rl-age">loading…</li>';
        else for (const m of n.commits) h += `<li>${link(m.url, `<span class="rl-mono">${esc(m.sha.slice(0, 7))}</span> ${esc(m.title)}`)}</li>`;
        h += '</ul>';
        if (n.commits && n.ahead > n.commits.length) h += `<div>${link(n.url, `…and ${n.ahead - n.commits.length} more — compare on GitHub`)}</div>`;
      }
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
      h += gridHtml(g) + '</div>' + detailHtml(g) + '<div class="rl-foot">' + LEGEND
        + (s.localOnly ? `<div class="rl-local" title="It isn't on GitHub yet, so teammates can't see this board. Commit and push it to share.">Local config, not pushed yet · <code>${esc(s.localOnly)}</code></div>` : '');
    }
    const prev = modal.querySelector('.rl-body'), top = prev ? prev.scrollTop : 0, left = prev ? prev.scrollLeft : 0;
    const height = modal.offsetHeight;
    modal.innerHTML = h + '</div>';
    const body = modal.querySelector('.rl-body');
    if (body) { body.scrollTop = top; body.scrollLeft = left; }
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
