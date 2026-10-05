// The "+" / "//" popover: pick a type, fuzzy-search it, Enter types "/name " into the
// selected agent's prompt. Lists come from main (catalog-core.js, cached per cwd);
// filtering is catalog-pick.js (loaded first; its functions are page globals). index.html loads this file and forwards
// { type: 'catalog' } messages to catalogUi.onMsg.
(function () {
  const TYPES = [
    { type: 'skill', icon: '⚡', label: 'Skills' },
    { type: 'command', icon: '⌘', label: 'Commands' },
    { type: 'agent', icon: '🤖', label: 'Agents' },
    { type: 'builtin', icon: '⚙', label: 'Built-in' },
  ];
  const ICON = Object.fromEntries(TYPES.map(t => [t.type, t.icon]));
  const ORIGIN = { repo: '📁', pc: '💻', plugin: '🧩', builtin: '⚙' };
  const cache = new Map(); // cwd -> items
  let isOpen = false, stage = 'types', type = null, sel = 0, rows = [], cwd = '';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const mark = (s, pos) => { const p = new Set(pos); return [...s].map((c, i) => p.has(i) ? `<b>${esc(c)}</b>` : esc(c)).join(''); };

  const btn = document.createElement('button');
  btn.id = 'catalog-btn';
  btn.title = 'Skills, commands and agents (type // in the terminal)';
  btn.textContent = '+';
  btn.onmousedown = (e) => e.stopPropagation(); // else the outside-click close fires first and this reopens it
  btn.onclick = () => { isOpen ? close() : open(); };
  const container = document.getElementById('term-container');
  container?.appendChild(btn);


  const pop = document.createElement('div');
  pop.id = 'catalog-pop';
  pop.hidden = true;
  pop.innerHTML = '<div class="cg-head"><span class="cg-scope"></span><input class="cg-q" spellcheck="false" placeholder="type to search everything"></div>'
    + '<div class="cg-list"></div><div class="cg-foot"></div>';
  document.body.appendChild(pop);
  const q = pop.querySelector('.cg-q'), list = pop.querySelector('.cg-list'), foot = pop.querySelector('.cg-foot'), scope = pop.querySelector('.cg-scope');
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
  function place() {
    const r = btn.getBoundingClientRect();
    pop.style.left = Math.max(8, r.left) + 'px';
    pop.style.bottom = Math.max(8, innerHeight - r.top + 6) + 'px'; // opens upward from the corner button
    pop.style.maxHeight = Math.min(560, r.top - 14) + 'px';
  }

  function onMsg(msg) {
    cache.set(msg.cwd, msg.items || []);
    if (isOpen && msg.cwd === cwd) render();
  }

  function render() {
    const items = cache.get(cwd);
    const query = q.value.trim();
    if (stage === 'types' && query) { stage = 'list'; type = null; sel = 0; }
    const t = TYPES.find(x => x.type === type);
    scope.innerHTML = stage === 'list' && t ? `${t.icon} ${t.label} ›` : '›';
    q.placeholder = stage === 'types' ? 'type to search everything' : `search ${t ? t.label.toLowerCase() : 'everything'}`;
    if (!items) { list.innerHTML = '<div class="cg-empty">Loading…</div>'; rows = []; return; }

    pop.classList.toggle('cg-narrow', stage === 'types'); // type menu is short; the list needs room for descriptions
    if (stage === 'types') {
      rows = TYPES;
      sel = Math.min(sel, rows.length - 1);
      list.innerHTML = TYPES.map((x, i) => `<div class="cg-row${i === sel ? ' sel' : ''}" data-i="${i}"><span class="cg-key">${i + 1}</span><span class="cg-icon">${x.icon}</span><span class="cg-name">${x.label}</span><span class="cg-count">${items.filter(it => it.type === x.type).length}</span></div>`).join('');
      foot.textContent = '1-4 pick · type to search all';
      return;
    }

    rows = pickItems(items, type, query).slice(0, 200);
    sel = Math.min(sel, Math.max(0, rows.length - 1));
    let html = '', group = null;
    rows.forEach((it, i) => {
      if (!query && it.group !== group) {
        group = it.group;
        const n = rows.filter(r => r.group === group).length;
        html += `<div class="cg-group">${ORIGIN[it.origin] || ''} ${esc(group)}${it.origin === 'repo' && cwd ? ' · ' + esc(cwd.split(/[\\/]/).pop()) : ''}<span class="cg-count">${n}</span></div>`;
      }
      const badge = it.overrides ? '<span class="cg-badge">overrides PC</span>' : it.shadowed ? '<span class="cg-badge dim">shadowed by repo</span>' : '';
      const where = query ? `<span class="cg-where">${ORIGIN[it.origin] || ''} ${esc(it.group)}</span>` : '';
      html += `<div class="cg-row${i === sel ? ' sel' : ''}${it.shadowed ? ' shadowed' : ''}" data-i="${i}" title="${esc(it.path || '/' + it.name)}">`
        + `<span class="cg-icon">${ICON[it.type] || ''}</span><span class="cg-name">${mark(it.name, it.pos)}</span>`
        + (it.hint ? `<span class="cg-hint">${esc(it.hint)}</span>` : '') + badge
        + `<span class="cg-desc">${esc(it.desc || '')}</span>${where}</div>`;
    });
    list.innerHTML = html || `<div class="cg-empty">${query ? 'No match' : type === 'skill' || type === 'command' || type === 'agent' ? 'None found — .claude/' + type + 's/ is empty here and in ~/.claude' : 'Nothing here'}</div>`;
    foot.textContent = 'Enter insert · ⇧Enter send · Tab type · ⌫ back · Ctrl+O open file · Esc';
    list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  }

  function choose(i, send) {
    const it = rows[i];
    if (!it) return;
    if (stage === 'types') { stage = 'list'; type = it.type; sel = 0; q.value = ''; render(); return; }
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
    if (stage === 'types' && /^[1-4]$/.test(k) && !q.value) { e.preventDefault(); choose(+k - 1); return; }
    if (k === 'Backspace' && !q.value && stage === 'list') { e.preventDefault(); stage = 'types'; type = null; sel = 0; render(); return; }
    if (e.ctrlKey && k.toLowerCase() === 'o' && stage === 'list') { e.preventDefault(); const p = rows[sel]?.path; if (p) api.send({ type: 'openFile', path: p }); }
  });
  // Hover only moves the highlight; a full render here would swap the row out from under the click.
  list.addEventListener('mousemove', (e) => { const r = e.target.closest('.cg-row'); if (!r || +r.dataset.i === sel) return; list.querySelector('.sel')?.classList.remove('sel'); r.classList.add('sel'); sel = +r.dataset.i; });
  list.addEventListener('click', (e) => { const r = e.target.closest('.cg-row'); if (r) choose(+r.dataset.i, e.shiftKey); });
  addEventListener('resize', () => { if (isOpen) place(); });

  window.catalogUi = { open, close, onMsg, isOpen: () => isOpen };
})();
