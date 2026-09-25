// Renderer side of the Releases board: footer badge, modal grid, cell detail,
// setup screen. Self-contained — index.html only loads this file, its stylesheet,
// and forwards { type: 'releases' } messages to releasesUi.onMsg.
(function () {
  let state = null, open = false, sel = null; // sel = [rowIdx, cellIdx]

  const core = document.createElement('script');
  core.src = './releases-core.js';
  core.onload = () => { if (open) render(); };
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
  document.addEventListener('keydown', (e) => { if (open && e.key === 'Escape') { e.stopPropagation(); show(false); } }, true);

  const actions = {
    close: () => show(false),
    refresh: () => api.send({ type: 'releasesRefresh' }),
    editSource: () => { state = { ...(state || {}), editing: true }; render(); },
    saveSource: () => {
      const v = modal.querySelector('#rl-src-input').value;
      state = { ...(state || {}), editing: false };
      api.send({ type: 'releasesSetSource', source: v });
    },
    cancelSource: () => { state = { ...(state || {}), editing: false }; render(); },
  };

  function show(on) {
    open = on;
    overlay.classList.toggle('open', on);
    api.send({ type: on ? 'releasesOpen' : 'releasesClose' });
    if (on) render();
  }

  function cellHtml(c, r, i) {
    if (!c) return '<div class="rl-empty"></div>';
    let top;
    if (c.loading) top = '<div class="rl-sha rl-age">loading…</div>';
    else if (c.missing) top = '<div class="rl-bad">branch missing</div>';
    else if (c.error) top = `<div class="rl-bad" title="${esc(c.error)}">! error</div>`;
    else top = `<div class="rl-sha">${esc(c.commit.sha.slice(0, 7))} <span class="rl-age">· ${esc(age(c.commit.date))}</span></div>`
      + `<div class="rl-title" title="${esc(c.commit.title)}">${esc(c.commit.title)}</div>`;
    const who = c.commit && c.commit.author ? ` · ${esc(c.commit.author)}` : '';
    let next = '';
    if (c.next) {
      const n = c.next;
      if (n.loading) next = `<div class="rl-next zero">… → ${esc(n.to)}</div>`;
      else if (n.error) next = `<div class="rl-next rl-bad" title="${esc(n.error)}">? → ${esc(n.to)}</div>`;
      else if (!n.ahead) next = `<div class="rl-next zero">in sync → ${esc(n.to)}</div>`;
      else next = `<div class="rl-next">${link(n.url, `${n.ahead} waiting → ${esc(n.to)}`)}</div>`;
    }
    const isSel = sel && sel[0] === r && sel[1] === i;
    return `<div class="rl-cell${isSel ? ' sel' : ''}" data-r="${r}" data-c="${i}">${top}<div class="rl-branch">${esc(c.branch)}${who}</div>${next}</div>`;
  }

  function detailHtml(grid) {
    const row = sel && grid.rows[sel[0]];
    const c = row && row.cells && row.cells[sel[1]];
    if (!c) return '';
    let h = `<div class="rl-detail"><h3>${esc(row.label)} · ${esc(c.env)} <span class="rl-mono">(${esc(c.branch)})</span></h3>`;
    if (c.commit) {
      h += `<div>${link(c.commit.url, `<span class="rl-mono">${esc(c.commit.sha.slice(0, 7))}</span> ${esc(c.commit.title)}`)}`
        + ` — ${esc(c.commit.author)}, ${esc(age(c.commit.date))} ago</div>`;
    }
    const n = c.next;
    if (n && !n.loading && !n.error) {
      if (!n.ahead) h += `<div style="margin-top:6px">Nothing waiting for ${esc(n.to)}.</div>`;
      else {
        h += `<div style="margin-top:6px">${n.ahead} commit${n.ahead === 1 ? '' : 's'} not yet in ${esc(n.to)} (newest first):</div><ul>`;
        for (const m of n.commits) h += `<li>${link(m.url, `<span class="rl-mono">${esc(m.sha.slice(0, 7))}</span> ${esc(m.title)}`)}</li>`;
        h += '</ul>';
        if (n.ahead > n.commits.length) h += `<div>${link(n.url, `…and ${n.ahead - n.commits.length} more — compare on GitHub`)}</div>`;
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

  function render() {
    if (!open) return;
    const s = state || { source: '', loading: true };
    const upd = s.updatedAt ? `updated ${new Date(s.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
    let h = '<div class="rl-head"><h2>Releases</h2>'
      + `<span class="rl-src" data-act="editSource" title="Change config source">${esc(s.source)}</span>`
      + `<span class="rl-upd">${s.loading ? 'loading…' : esc(upd)}</span>`
      + `<button data-act="refresh" class="${s.loading ? 'spin' : ''}" title="Refresh">⟳</button>`
      + '<button data-act="close" title="Close (Esc)">×</button></div><div class="rl-body">';
    const g = s.grid;
    if (s.editing || !g || s.error || s.problems) {
      h += (!g && s.loading && !s.error && !s.problems && !s.editing) ? '<div class="rl-age">Loading…</div>' : setupHtml(s);
    } else if (!window.ReleasesCore) {
      h += '<div class="rl-age">Loading…</div>';
    } else {
      h += `<div class="rl-grid" style="grid-template-columns:auto repeat(${g.envs.length}, minmax(150px, 1fr))">`
        + '<div></div>' + g.envs.map(e => `<div class="rl-colhead">${esc(e)}</div>`).join('');
      g.rows.forEach((row, r) => {
        h += `<div class="rl-label">${link(`https://github.com/${row.repo}`, esc(row.label))}</div>`;
        h += row.note ? `<div class="rl-note">${esc(row.note)}</div>` : row.cells.map((c, i) => cellHtml(c, r, i)).join('');
      });
      h += '</div>' + detailHtml(g);
    }
    modal.innerHTML = h + '</div>';
    const inp = modal.querySelector('#rl-src-input');
    if (inp) inp.onkeydown = (e) => { if (e.key === 'Enter') actions.saveSource(); };
  }

  window.releasesUi = { onMsg(msg) { state = { ...msg.state, editing: state && state.editing && !msg.state.error ? state.editing : false }; render(); } };
})();
