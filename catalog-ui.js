// The "+" / "//" popover: pick a type, fuzzy-search it, Enter types "/name " into the
// selected agent's prompt. Lists come from main (catalog-core.js, cached per cwd);
// filtering is catalog-pick.js (loaded first; its functions are page globals). index.html loads this file and forwards
// { type: 'catalog' } messages to catalogUi.onMsg.
(function () {
  // Lucide-style strokes, matching the app's other .ic icons.
  const SVG = {
    skill: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    command: '<path d="m16 4-8 16"/>',
    agent: '<rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V4M9 13v2M15 13v2"/>',
    mod: '<path d="M12 2v4M12 18v4M4 12H2M22 12h-2"/><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M10 10h4v4h-4z"/>',
    builtin: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  };
  const icon = (type) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${SVG[type] || ''}</svg>`;
  const TYPES = [
    { type: 'skill', label: 'Skills' },
    { type: 'command', label: 'Commands' },
    { type: 'agent', label: 'Agents' },
    { type: 'mod', label: 'Mods' },
    { type: 'builtin', label: 'Built-in' },
  ];
  const cache = new Map(); // cwd -> items
  let config = { enabled: true, hotkey: '//' }; // Settings → Skills picker
  let isOpen = false, stage = 'types', type = null, sel = 0, rows = [], cwd = '';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const mark = (s, pos, from = 0, to = s.length) => { const p = new Set(pos); let o = ''; for (let i = from; i < to; i++) o += p.has(i) ? `<b>${esc(s[i])}</b>` : esc(s[i]); return o; };
  // Plugin items are "plugin:name"; the plugin part is dimmed, and hidden under its own group header.
  const nameHtml = (it) => { const k = it.origin === 'plugin' ? it.name.indexOf(':') + 1 : 0;
    return (k ? `<span class="cg-pfx">${mark(it.name, it.pos, 0, k)}</span>` : '') + mark(it.name, it.pos, k); };
  const tilde = (p) => String(p || '').replace(/^[A-Z]:[\\/]Users[\\/][^\\/]+/i, '~').replace(/\\/g, '/');
  const plus = (type, label) => newItemPrompt(type) ? `<button class="cg-new" data-new="${type}" title="Start an agent that makes a new ${label}">+</button>` : '';
  const kbd = (k, label) => `<span class="cg-k"><kbd>${k}</kbd>${label}</span>`;

  const btn = document.createElement('button');
  btn.id = 'catalog-btn';
  btn.title = 'Skills, commands and agents (//)';
  btn.textContent = '+';
  btn.onmousedown = (e) => e.stopPropagation(); // else the outside-click close fires first and this reopens it
  btn.onclick = () => { isOpen ? close() : open(); };
  const container = document.getElementById('term-container');
  container?.appendChild(btn);


  const pop = document.createElement('div');
  pop.id = 'catalog-pop';
  pop.hidden = true;
  pop.innerHTML = '<div class="cg-head"><span class="cg-scope"></span><input class="cg-q" spellcheck="false"><kbd class="cg-esc">Esc</kbd></div>'
    + '<div class="cg-tabs"></div><div class="cg-list"></div><div class="cg-detail"></div><div class="cg-foot"></div>';
  document.body.appendChild(pop);
  const $ = (c) => pop.querySelector(c);
  const q = $('.cg-q'), list = $('.cg-list'), foot = $('.cg-foot'), scope = $('.cg-scope'), tabs = $('.cg-tabs'), detail = $('.cg-detail');
  pop.addEventListener('mousedown', (e) => e.stopPropagation());
  document.addEventListener('mousedown', () => { if (isOpen) close(); });

  const agentCwd = () => agents.get(selectedId)?.cwd || '';

  function open() {
    if (selectedId == null) return;
    cwd = agentCwd();
    api.send({ type: 'catalog', cwd }); // ponytail: rescan every open (~10 ms); the cached list shows meanwhile
    isOpen = true; stage = 'types'; type = null; sel = 0; q.value = '';
    pop.hidden = false; place(); render(); q.focus();
  }
  function close(refocus = true) {
    if (!isOpen) return;
    isOpen = false; pop.hidden = true;
    if (refocus) xterms.get(selectedId)?.terminal?.focus();
  }
  // Screen y of the top of Claude's prompt box, or null (no prompt in view, or scrolled up).
  function promptY() {
    const x = xterms.get(selectedId), t = x?.terminal, b = t?.buffer.active, screen = x?.el.querySelector('.xterm-screen');
    if (!screen || b.viewportY !== b.baseY) return null;
    const lines = [];
    for (let i = 0; i < t.rows; i++) lines.push(b.getLine(b.viewportY + i)?.translateToString() || '');
    const row = promptTop(lines);
    if (row < 0) return null;
    const r = screen.getBoundingClientRect();
    return r.top + row * (r.height / t.rows);
  }
  function place() {
    const r = btn.getBoundingClientRect();
    const py = promptY(), top = container.getBoundingClientRect().top;
    // Above the prompt box so what you're typing stays readable — unless that leaves too little room; then above the + button.
    const y = py != null && py - top >= 340 ? py : r.top;
    pop.style.left = Math.max(8, r.left) + 'px';
    pop.style.bottom = Math.max(8, innerHeight - y + 6) + 'px';
    pop.style.maxHeight = Math.min(560, y - 14) + 'px';
  }

  function onMsg(msg) {
    cache.set(msg.cwd, msg.items || []);
    if (isOpen && msg.cwd === cwd) render();
  }

  function groupHead(it, n) {
    const [name, market] = it.group.split(' · ');
    const sub = it.origin === 'repo' ? esc(cwd.split(/[\\/]/).pop()) : it.origin === 'pc' ? '~/.claude'
      : it.origin === 'plugin' ? 'plugin · ' + esc(market || '') : '';
    return `<div class="cg-group"><span>${esc(name)}</span><span class="cg-sub">${sub}</span><span class="cg-count">${n}</span></div>`;
  }

  function renderDetail() {
    const it = stage === 'list' && rows[sel];
    detail.hidden = stage !== 'list';
    detail.style.visibility = it ? '' : 'hidden'; // no match: keep the pane's space so the card doesn't shrink
    if (!it) return;
    const where = it.origin === 'builtin' ? 'Built into Claude Code' : tilde(it.path);
    const note = it.overrides ? '<span class="cg-badge">overrides ~/.claude</span>'
      : it.shadowed ? '<span class="cg-badge dim">hidden by this repo’s copy</span>' : '';
    const runs = !it.insert ? '<span class="cg-badge dim">runs on its own — nothing to insert</span>' : '';
    detail.innerHTML = `<div class="cg-d-title"><span>${esc(it.insert.trim() || it.name)}</span>${it.hint ? `<span class="cg-hint">${esc(it.hint)}</span>` : ''}${note || runs}</div>`
      + `<div class="cg-d-desc">${esc(it.desc || 'No description.')}</div><div class="cg-d-path" title="${esc(it.path || '')}"><bdi>${esc(where)}</bdi></div>`;
  }

  function render() {
    const items = cache.get(cwd);
    const query = q.value.trim();
    if (stage === 'types' && query) { stage = 'list'; type = null; sel = 0; }
    const t = TYPES.find(x => x.type === type);
    pop.classList.toggle('cg-narrow', stage === 'types'); // the type menu is short; the list needs room
    scope.innerHTML = t && stage === 'list' ? icon(t.type) : '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
    q.placeholder = stage === 'types' ? 'Search everything…' : `Search ${t ? t.label.toLowerCase() : 'everything'}…`;
    if (!items) { tabs.hidden = true; list.innerHTML = '<div class="cg-empty">Loading…</div>'; rows = []; renderDetail(); foot.innerHTML = ''; return; }
    const count = (ty) => items.filter(it => it.type === ty).length;

    if (stage === 'types') {
      tabs.hidden = true;
      rows = TYPES;
      sel = Math.min(sel, rows.length - 1);
      list.innerHTML = TYPES.map((x, i) => { const n = count(x.type);
        return `<div class="cg-row cg-type${i === sel ? ' sel' : ''}${n ? '' : ' cg-none'}" data-i="${i}"><span class="cg-icon">${icon(x.type)}</span>`
          + `<span class="cg-name">${x.label}</span><span class="cg-count">${n}</span>${plus(x.type, x.label.toLowerCase().replace(/s$/, ''))}<kbd>${i + 1}</kbd></div>`; }).join('');
      renderDetail();
      foot.innerHTML = kbd('1–5', 'pick') + kbd('↵', 'open') + kbd('Esc', 'close');
      return;
    }

    // Tabs: All + every type that has something. Click, or Tab / ⇧Tab, to switch.
    tabs.hidden = false;
    tabs.innerHTML = [{ type: null, label: 'All' }, ...TYPES].filter(x => !x.type || count(x.type))
      .map(x => `<button class="cg-tab${x.type === type ? ' on' : ''}" data-type="${x.type || ''}">${x.label}<span>${x.type ? count(x.type) : items.length}</span></button>`).join('')
      + (t && newItemPrompt(t.type) ? `<button class="cg-new cg-new-tab" data-new="${t.type}" title="Start an agent that makes one">+ New ${t.label.toLowerCase().replace(/s$/, '')}</button>` : '');

    rows = pickItems(items, type, query).slice(0, 200);
    sel = Math.min(sel, Math.max(0, rows.length - 1));
    const grouped = !query;
    list.classList.toggle('grouped', grouped);
    let html = '', group = null;
    rows.forEach((it, i) => {
      if (grouped && it.group !== group) { group = it.group; html += groupHead(it, rows.filter(r => r.group === group).length); }
      const src = grouped ? '' : `<span class="cg-src">${esc(it.group.split(' · ')[0])}</span>`;
      html += `<div class="cg-row${i === sel ? ' sel' : ''}${it.shadowed ? ' shadowed' : ''}" data-i="${i}">`
        + (type ? '' : `<span class="cg-icon">${icon(it.type)}</span>`)
        + `<span class="cg-name">${nameHtml(it)}</span>`
        + (it.overrides ? '<span class="cg-dot" title="Overrides ~/.claude"></span>' : '')
        + `<span class="cg-desc">${esc(it.desc || '')}</span>${src}</div>`;
    });
    list.innerHTML = html || `<div class="cg-empty">${query ? `Nothing matches “${esc(query)}”` : 'Nothing here yet'}</div>`;
    renderDetail();
    foot.innerHTML = kbd('↵', 'insert') + kbd('⇧↵', 'send') + kbd('Tab', 'switch type') + kbd('Ctrl O', 'open file');
    list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  }

  function choose(i, send) {
    const it = rows[i];
    if (!it) return;
    if (stage === 'types') { stage = 'list'; type = it.type; sel = 0; q.value = ''; render(); return; }
    if (!it.insert) return; // a mod with no command — the detail pane says it runs on its own
    const id = selectedId;
    close();
    api.send({ type: 'termInput', id, data: send ? it.insert.trimEnd() + '\r' : it.insert });
  }

  function cycle(dir) {
    const order = [null, ...TYPES.map(t => t.type)];
    type = order[(order.indexOf(type) + dir + order.length) % order.length];
    stage = 'list'; sel = 0; render();
  }

  q.addEventListener('input', () => { sel = 0; render(); });
  q.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'Escape') { e.preventDefault(); close(); return; }
    if (k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); if (rows.length) { sel = (sel + (k === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length; render(); } return; }
    if (k === 'Enter') { e.preventDefault(); choose(sel, e.shiftKey); return; }
    if (k === 'Tab') { e.preventDefault(); cycle(e.shiftKey ? -1 : 1); return; }
    if (stage === 'types' && /^[1-5]$/.test(k) && !q.value) { e.preventDefault(); choose(+k - 1); return; }
    if (k === 'Backspace' && !q.value && stage === 'list') { e.preventDefault(); stage = 'types'; type = null; sel = 0; render(); return; }
    if (e.ctrlKey && k.toLowerCase() === 'o' && stage === 'list') { e.preventDefault(); const p = rows[sel]?.path; if (p) api.send({ type: 'openFile', path: p }); }
  });
  // Hover only moves the highlight; a full render here would swap the row out from under the click.
  list.addEventListener('mousemove', (e) => { const r = e.target.closest('.cg-row'); if (!r || +r.dataset.i === sel) return; list.querySelector('.sel')?.classList.remove('sel'); r.classList.add('sel'); sel = +r.dataset.i; renderDetail(); });
  // "+" on a type: a fresh agent in this project, primed to make a new one of that type.
  pop.addEventListener('click', (e) => {
    const b = e.target.closest('.cg-new');
    if (!b) return;
    e.stopPropagation();
    const prompt = newItemPrompt(b.dataset.new);
    if (!prompt || !cwd) return;
    close(false);
    api.send({ type: 'createAgent', cwd, prompt });
  }, true);
  tabs.addEventListener('click', (e) => { const b = e.target.closest('.cg-tab'); if (!b) return; type = b.dataset.type || null; stage = 'list'; sel = 0; render(); q.focus(); });
  list.addEventListener('click', (e) => { const r = e.target.closest('.cg-row'); if (r) choose(+r.dataset.i, e.shiftKey); });
  addEventListener('resize', () => { if (isOpen) place(); });
  // A chord hotkey (Ctrl+K…) works anywhere; capture so the terminal never sees it.
  document.addEventListener('keydown', (e) => {
    if (!config.enabled || e.target.id === 'inp-catalog-hotkey' || !chordMatch(e, parseHotkey(config.hotkey))) return; // not while Settings records a new one
    e.preventDefault(); e.stopPropagation();
    isOpen ? close() : open();
  }, true);

  function setConfig(s) {
    config = { enabled: s.catalogEnabled !== false, hotkey: s.catalogHotkey || '//' };
    btn.hidden = !config.enabled;
    btn.title = `Skills, commands and agents (${config.hotkey})`;
    if (!config.enabled) close(false);
  }
  // The typed sequence the terminal gate watches for; '' when off or the hotkey is a chord.
  const seq = () => (config.enabled ? config.hotkey : '');

  window.catalogUi = { open, close, onMsg, setConfig, seq, isOpen: () => isOpen };
})();
