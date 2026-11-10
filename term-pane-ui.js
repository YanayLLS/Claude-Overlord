// Terminals pane, window side: a dock under the chat with a tab per dev-script window (term-pane.js).
// Globals from the page: api, XTerminal, XFitAddon, xtermTheme, currentTheme.
(function () {
  const ICON = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2"/></svg>';
  const tabs = new Map(); // name -> { info, el, tabEl, term, fit, pending }
  let active = null, open = false;
  const H_KEY = 'tpHeight';
  let height = (() => { try { return +localStorage.getItem(H_KEY) || 260; } catch { return 260; } })();

  const btn = document.createElement('button');
  btn.className = 'hdr-btn'; btn.id = 'tp-btn'; btn.title = 'Terminals'; btn.style.display = 'none';
  btn.innerHTML = ICON + '<span id="tp-count"></span>';
  const hdrChat = document.getElementById('hdr-chat');
  hdrChat.parentNode.insertBefore(btn, hdrChat);

  const dock = document.createElement('div');
  dock.id = 'tp-dock';
  dock.innerHTML = '<div id="tp-grip"></div><div id="tp-bar"><div id="tp-tabs" role="tablist"></div><button id="tp-hide" title="Hide">'
    + '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button></div><div id="tp-body"></div>';
  document.getElementById('content').after(dock);
  const tabsEl = dock.querySelector('#tp-tabs'), body = dock.querySelector('#tp-body');

  const measurable = () => body.clientWidth > 0 && body.clientHeight > 0;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function setOpen(v) {
    open = v && tabs.size > 0;
    dock.classList.toggle('open', open);
    dock.style.height = open ? height + 'px' : '';
    btn.classList.toggle('active', open);
    btn.setAttribute('aria-expanded', String(open));
    if (open) { btn.classList.remove('pulse'); requestAnimationFrame(() => { ensureTerm(active); fitActive(); }); }
  }

  function ensureTerm(name) {
    const t = tabs.get(name);
    if (!t || t.term || !measurable()) return;
    const term = new XTerminal({ theme: xtermTheme(currentTheme), fontFamily: '"Cascadia Mono","Cascadia Code",Consolas,monospace', fontSize: 12, lineHeight: 1.2, scrollback: 5000, cursorStyle: 'bar' });
    const fit = new XFitAddon();
    term.loadAddon(fit);
    term.open(t.el);
    fit.fit();
    term.onData((d) => api.send({ type: 'tp:input', name, d }));
    // Ctrl+C copies when text is selected (else it's ^C to the server); Ctrl+V pastes.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !e.ctrlKey) return true;
      if (e.key === 'c' && term.hasSelection()) { navigator.clipboard.writeText(term.getSelection()); term.clearSelection(); return false; }
      if (e.key === 'v') { navigator.clipboard.readText().then((s) => s && api.send({ type: 'tp:input', name, d: s })); return false; }
      return true;
    });
    t.term = term; t.fit = fit;
    if (t.pending) { term.write(t.pending); t.pending = ''; }
  }

  function fitActive() {
    const t = tabs.get(active);
    if (!t || !t.fit || !measurable()) return;
    try { t.fit.fit(); api.send({ type: 'tp:resize', cols: t.term.cols, rows: t.term.rows }); } catch {}
  }

  function select(name) {
    active = name;
    for (const [n, t] of tabs) { t.el.style.visibility = n === name ? 'visible' : 'hidden'; t.tabEl.classList.toggle('on', n === name); t.tabEl.setAttribute('aria-selected', String(n === name)); }
    if (open) { ensureTerm(name); fitActive(); const t = tabs.get(name); if (t && t.term) t.term.focus(); }
  }

  function state(info) { return info.running ? 'run' : (info.code ? 'fail' : 'stop'); }

  function renderTab(t) {
    const s = state(t.info);
    t.tabEl.className = 'tp-tab ' + s + (t.tabEl.classList.contains('on') ? ' on' : '');
    t.tabEl.title = `${t.info.cwd}\n${t.info.line}` + (s === 'run' ? '' : `\nexited${t.info.code != null ? ' ' + t.info.code : ''}`);
    t.tabEl.innerHTML = `<i class="tp-dot"></i><span class="tp-name">${esc(t.info.name)}</span>`
      + `<button class="tp-act" data-a="restart" title="Restart"><svg class="ic" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg></button>`
      + `<button class="tp-act" data-a="close" title="${s === 'run' ? 'Stop and close' : 'Close'}"><svg class="ic" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg></button>`;
  }

  function onList(list) {
    const seen = new Set();
    for (const info of list) {
      seen.add(info.name);
      let t = tabs.get(info.name);
      if (!t) {
        const el = document.createElement('div'); el.className = 'tp-term'; body.appendChild(el);
        const tabEl = document.createElement('div'); tabEl.setAttribute('role', 'tab'); tabEl.dataset.name = info.name; tabsEl.appendChild(tabEl);
        t = { info, el, tabEl, term: null, fit: null, pending: '' };
        tabs.set(info.name, t);
      }
      t.info = info; renderTab(t);
    }
    for (const [n, t] of [...tabs]) if (!seen.has(n)) { if (t.term) t.term.dispose(); t.el.remove(); t.tabEl.remove(); tabs.delete(n); }
    const running = list.filter(i => i.running).length;
    btn.style.display = tabs.size ? '' : 'none';
    btn.querySelector('#tp-count').textContent = tabs.size;
    btn.classList.toggle('live', running > 0);
    btn.title = `Terminals: ${running} running` + (tabs.size > running ? `, ${tabs.size - running} stopped` : '');
    if (!tabs.has(active)) active = tabs.size ? [...tabs.keys()][0] : null;
    if (!tabs.size) setOpen(false);
    select(active);
  }

  function onData(name, d, replay) {
    const t = tabs.get(name);
    if (!t) return;
    if (replay && t.term) { t.term.reset(); }
    if (t.term) t.term.write(d);
    else { t.pending = (replay ? '' : t.pending) + d; if (t.pending.length > 262144) t.pending = t.pending.slice(-262144); }
  }

  api.on((m) => {
    if (m.type === 'tp:list') onList(m.tabs);
    else if (m.type === 'tp:data') onData(m.name, m.d, m.replay);
    else if (m.type === 'tp:opened') { if (open) select(m.name); else { active = m.name; btn.classList.add('pulse'); } }
  });

  btn.onclick = () => setOpen(!open);
  dock.querySelector('#tp-hide').onclick = () => setOpen(false);
  tabsEl.addEventListener('click', (e) => {
    const tab = e.target.closest('.tp-tab'); if (!tab) return;
    const name = tab.dataset.name, act = e.target.closest('.tp-act');
    if (!act) return select(name);
    if (act.dataset.a === 'restart') { const t = tabs.get(name); if (t && t.term) t.term.reset(); api.send({ type: 'tp:restart', name }); }
    else api.send({ type: 'tp:close', name });
  });

  // Drag the top edge to resize; the height sticks.
  dock.querySelector('#tp-grip').addEventListener('pointerdown', (e) => {
    const startY = e.clientY, startH = height, grip = e.target;
    grip.setPointerCapture(e.pointerId);
    const move = (ev) => { height = Math.max(120, Math.min(window.innerHeight - 160, startH + startY - ev.clientY)); dock.style.height = height + 'px'; fitActive(); };
    const up = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); try { localStorage.setItem(H_KEY, String(height)); } catch {} };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up);
  });
  new ResizeObserver(() => { if (open) fitActive(); }).observe(body);

  window.TermPane = { setTheme: (n) => { for (const t of tabs.values()) if (t.term) t.term.options.theme = xtermTheme(n); } };
  api.send({ type: 'tp:sync' });
})();
