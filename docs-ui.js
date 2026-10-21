// Markdown documents in the page: a Docs column beside the terminal (like the web preview column),
// with the open files as tabs across its top. The agent's terminal stays where it is, so a plan an
// agent is writing can be read while it writes: files the focused agent edits with Write/Edit open
// here by themselves ("follow"), and every open file re-renders when it changes on disk.
// Rendering is marked + highlight.js, sanitized by DOMPurify (md-bundle.js); pure helpers come
// from docs-core.js (page globals). index.html forwards { type: 'doc*' } messages to docsUi.onMsg,
// tool completions to docsUi.onToolFile, and asks docsUi.hasFocus() before Ctrl+W / Ctrl+Tab / Ctrl+F.
(function () {
  const docs = new Map();      // path -> { path, title, text, mtime, scrollTop, changedAt, gone }
  let order = [];              // tab order, oldest first
  let selected = null;         // the tab shown
  let visible = false;         // the column is open
  let focused = false;         // the last click landed in the column (keyboard shortcuts go to it)
  let follow = true;           // open what the focused agent writes
  let find = { q: '', marks: [], i: -1 };
  let outlineOpen = false;
  let editing = false;         // the raw markdown is shown in the editor instead of the rendering
  let hiddenByUser = false;    // the column was closed by hand with docs open: follow adds tabs, doesn't pop it back
  let followPending = null;    // the doc follow would have shown while the column was hidden
  let saveTimer = 0, dirty = false; // editor autosave
  let zoom = 1;
  const pendingHash = new Map(); // doc path -> anchor to land on once it opens
  let refs = null;

  const $ = (id) => document.getElementById(id);
  const ICON = {
    doc: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M8 13h8M8 17h5"/></svg>',
    folder: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    ext: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"/></svg>',
    list: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/></svg>',
    find: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>',
    eye: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    plus: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    pen: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    copy: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  };

  // ── DOM: built once ──────────────────────────────────────────────────────────────────
  function build() {
    const content = $('content');
    const handle = document.createElement('div'); handle.id = 'doc-resize';
    const col = document.createElement('div'); col.id = 'doc-col';
    col.innerHTML = `<div id="doc-tabs"><div id="doc-tablist" role="tablist"></div>`
      + `<button id="doc-add" onclick="docsUi.addMenu(event)" title="New note / open .md…">${ICON.plus}</button><span class="doc-sp"></span><span id="doc-updated"></span>`
      + `<button id="doc-edit-btn" onclick="docsUi.toggleEdit()" title="Edit the markdown (Ctrl+E) — saves as you type">${ICON.pen}</button>`
      + `<button id="doc-follow-btn" onclick="docsUi.toggleFollow()" title="Follow: open the .md files the focused agent writes">${ICON.eye}</button>`
      + `<button id="doc-outline-btn" onclick="docsUi.toggleOutline()" title="Outline">${ICON.list}</button>`
      + `<button onclick="docsUi.openFind()" title="Find in document (Ctrl+F)">${ICON.find}</button>`
      + `<button onclick="docsUi.toggle()" class="doc-col-x" title="Hide documents (Ctrl+Shift+D)" aria-label="Hide documents">&times;</button></div>`
      + `<div id="doc-path" hidden><span id="doc-path-text" title="Click to copy the path"></span><button onclick="docsUi.copyPath()" title="Copy path">${ICON.copy}</button><button onclick="docsUi.reveal()" title="Show in folder">${ICON.folder}</button><button onclick="docsUi.openWith()" title="Open in your editor">${ICON.ext}</button></div>`
      + '<div id="doc-find" hidden><input id="doc-find-input" type="text" placeholder="Find in document…" /><span id="doc-find-count"></span><button onclick="docsUi.findStep(-1)" title="Previous (Shift+Enter)">&#x25B2;</button><button onclick="docsUi.findStep(1)" title="Next (Enter)">&#x25BC;</button><button onclick="docsUi.closeFind()" title="Close (Esc)">&times;</button></div>'
      + '<div id="doc-scroll"><div id="doc-meta"></div><article id="doc-view" class="md"></article><div id="doc-empty">No document open.<br><small>Press + above for a new note or to open an .md file, double-click one, or drop it here.<br>Files the focused agent writes open here by themselves.</small></div></div>'
      + '<textarea id="doc-editor" class="md-src" hidden spellcheck="false" placeholder="Write markdown here — it saves as you type."></textarea>'
      + '<nav id="doc-outline" hidden aria-label="Outline"></nav>';
    // Before the web preview column when it is already there, so the order is terminal · docs · preview.
    const pv = $('preview-resize');
    if (pv) { content.insertBefore(handle, pv); content.insertBefore(col, pv); } else { content.appendChild(handle); content.appendChild(col); }

    // Header button, always visible, next to the world-view button: opens the column (with the file
    // picker when nothing is open yet). A badge shows how many files are open.
    const btn = document.createElement('button');
    btn.id = 'doc-toggle'; btn.className = 'hdr-btn'; btn.title = 'Documents: markdown files beside the terminal (Ctrl+Shift+D)';
    btn.innerHTML = `${ICON.doc}<b id="doc-toggle-n"></b>`;
    const world = $('hdr-world');
    if (world) world.insertAdjacentElement('afterend', btn); else $('header').insertBefore(btn, $('addBtn'));
    btn.onclick = () => { if (!visible && !order.length) { setVisible(true); pick(); } else toggle(); };

    refs = { col, handle, btn, tablist: col.querySelector('#doc-tablist'), scroll: col.querySelector('#doc-scroll'), view: col.querySelector('#doc-view'), meta: col.querySelector('#doc-meta'), empty: col.querySelector('#doc-empty'), updated: col.querySelector('#doc-updated'), followBtn: col.querySelector('#doc-follow-btn'),
      editor: col.querySelector('#doc-editor'), editBtn: col.querySelector('#doc-edit-btn'), pathBar: col.querySelector('#doc-path'), pathText: col.querySelector('#doc-path-text') };

    // Drag-resize on the column's left edge; width is remembered.
    let dragging = false, startX = 0, startW = 0, startTermW = 0;
    handle.addEventListener('mousedown', (e) => { dragging = true; startX = e.clientX; startW = col.offsetWidth; const t = $('term'); startTermW = t && t.classList.contains('open') ? t.offsetWidth : 0; document.body.style.userSelect = 'none'; document.body.style.cursor = 'ew-resize'; e.preventDefault(); });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      // This grip moves the terminal/column boundary only: the terminal gives exactly what the column
      // takes (and gets it back), the roster moves only once the terminal is at its minimum.
      setWidth(startW - (e.clientX - startX), startTermW ? startTermW + startW : 0);
      window.dispatchEvent(new Event('resize')); // the terminal beside it refits
    });
    window.addEventListener('mouseup', () => { if (!dragging) return; dragging = false; document.body.style.userSelect = ''; document.body.style.cursor = ''; try { localStorage.setItem('overlord-doc-width', String(col.offsetWidth)); } catch {} });

    // Keyboard shortcuts belong to the column after a click inside it, to the terminal otherwise.
    document.addEventListener('mousedown', (e) => { focused = col.contains(e.target); }, true);
    // A plain click in the rendered text (no selection made) hands the keyboard straight back to
    // the terminal: the usual move is "glance at the doc, keep typing to the agent". Selecting text,
    // the tabs, the editor and the find box keep the keyboard here.
    refs.scroll.addEventListener('mouseup', (e) => {
      if (e.button !== 0 || e.target.closest('a, button, input, summary')) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && refs.scroll.contains(sel.anchorNode)) return;
      setTimeout(() => { const s = window.getSelection(); if (s && !s.isCollapsed) return; const x = typeof xterms !== 'undefined' && xterms.get(selectedId); if (x) x.terminal.focus(); }, 0);
    });
    const termEl = $('term'); if (termEl) termEl.addEventListener('focusin', () => { focused = false; });
    refs.pathText.addEventListener('click', copyPath);
    // Editor: every keystroke lands in the file after a short pause; Tab indents; Esc goes back to the rendering.
    refs.editor.addEventListener('input', () => {
      const d = docs.get(selected); if (!d) return;
      d.text = refs.editor.value; dirty = true;
      clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, 350);
    });
    refs.editor.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        const t = refs.editor, s = t.selectionStart, en = t.selectionEnd;
        t.setRangeText('  ', s, en, 'end'); t.dispatchEvent(new Event('input'));
      } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(false); }
      else if (e.key === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); flushSave(); showToast('Saved'); }
    });
    refs.editor.addEventListener('scroll', () => { const d = docs.get(selected); if (d) d.editScrollTop = refs.editor.scrollTop; }, { passive: true });
    // Esc closes the outline; Ctrl+= / Ctrl+- / Ctrl+0 zoom the text while the column has the keyboard.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && outlineOpen && !e.target.closest('input, textarea')) { setOutline(false); return; }
      if (!hasFocus() || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.key === '=' || e.key === '+') { e.preventDefault(); e.stopImmediatePropagation(); setZoom(zoom + 0.1); }
      else if (e.key === '-') { e.preventDefault(); e.stopImmediatePropagation(); setZoom(zoom - 0.1); }
      else if (e.key === '0') { e.preventDefault(); e.stopImmediatePropagation(); setZoom(1); }
      else if ((e.key === 'e' || e.key === 'E') && !e.shiftKey) { e.preventDefault(); e.stopImmediatePropagation(); toggleEdit(); }
    }, true);
    // Tabs reorder by drag. The page's file-drop handler only reacts to OS file drags, so this is left alone.
    let dragTab = null;
    refs.tablist.addEventListener('dragstart', (e) => { const t = e.target.closest('.doc-tab'); if (!t) return; dragTab = t.dataset.path; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/x-overlord-doc', dragTab); t.classList.add('dragging'); });
    refs.tablist.addEventListener('dragend', () => { dragTab = null; for (const t of refs.tablist.querySelectorAll('.doc-tab')) t.classList.remove('dragging', 'drop-before', 'drop-after'); });
    refs.tablist.addEventListener('dragover', (e) => {
      if (!dragTab) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move';
      const t = e.target.closest('.doc-tab');
      for (const x of refs.tablist.querySelectorAll('.doc-tab')) x.classList.remove('drop-before', 'drop-after');
      if (!t || t.dataset.path === dragTab) return;
      const r = t.getBoundingClientRect(); t.classList.add(e.clientX < r.left + r.width / 2 ? 'drop-before' : 'drop-after');
    });
    refs.tablist.addEventListener('drop', (e) => {
      if (!dragTab) return; e.preventDefault(); e.stopPropagation();
      const t = e.target.closest('.doc-tab'); const from = dragTab; dragTab = null;
      if (!t || t.dataset.path === from) { renderTabs(); return; }
      const r = t.getBoundingClientRect(); const before = e.clientX < r.left + r.width / 2;
      order = withoutDoc(order, from); let i = order.indexOf(t.dataset.path); if (!before) i++;
      order.splice(i, 0, from); renderTabs();
    });
    try { zoom = +localStorage.getItem('overlord-doc-zoom') || 1; } catch {} setZoom(zoom, true);

    const fi = col.querySelector('#doc-find-input');
    fi.addEventListener('input', () => runFind(fi.value));
    fi.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
    });
    refs.view.addEventListener('click', onViewClick);
    // Ticking a task writes "[x]" / "[ ]" into the file at once; the n-th box is the n-th marker in the source.
    refs.view.addEventListener('change', (e) => {
      const box = e.target; if (!(box instanceof HTMLInputElement) || box.type !== 'checkbox') return;
      const d = docs.get(selected); if (!d) return;
      const n = [...refs.view.querySelectorAll('input[type=checkbox]')].indexOf(box);
      const next = toggleTask(d.text, n, box.checked);
      if (next == null) { box.checked = !box.checked; showToast('Could not find that task in the file'); return; }
      d.text = next;
      api.send({ type: 'docWrite', path: d.path, text: next });
    });
    refs.view.addEventListener('error', (e) => { if (e.target.tagName === 'IMG') e.target.classList.add('broken'); }, true); // a missing image shows its alt text, not a broken icon
    refs.scroll.addEventListener('scroll', () => { const d = docs.get(selected); if (d) d.scrollTop = refs.scroll.scrollTop; }, { passive: true });
    col.querySelector('#doc-outline').addEventListener('click', (e) => { const a = e.target.closest('a[data-id]'); if (a) { e.preventDefault(); scrollToId(a.dataset.id); } });
    refs.tablist.addEventListener('auxclick', (e) => { const t = e.target.closest('.doc-tab'); if (t && e.button === 1) { e.preventDefault(); close(t.dataset.path); } });
    refs.tablist.addEventListener('wheel', (e) => { if (e.deltaY && !e.deltaX) { refs.tablist.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
    // .md files dropped anywhere in the window open here: the page's drop handler (index.html) routes them.

    window.addEventListener('resize', () => { if (visible && !dragging) setWidth(refs.col.offsetWidth); });
    const termGrip = $('resize'); if (termGrip) termGrip.addEventListener('mousedown', () => { termWanted = 0; }); // a terminal drag sets a new wanted width (read on the next layout pass)
    try { follow = localStorage.getItem('overlord-doc-follow') !== '0'; } catch {}
    refs.followBtn.classList.toggle('active', follow);
    let w = 0; try { w = +localStorage.getItem('overlord-doc-width') || 0; } catch {}
    if (w) col.style.width = w + 'px';
    renderTabs();
  }

  // The column may grow until the roster (200px) and the terminal (200px) are at their minimums: the
  // terminal gives way first, so the row never overflows and the column's right edge stays on screen.
  // The terminal keeps the width the user gave it ("wanted"): it shrinks only while the column needs
  // the room and grows straight back as the column narrows, so the roster stays put until the
  // terminal is whole again.
  const ROSTER_MIN = 200, TERM_MIN = 200, GRIPS = 8;
  let termWanted = 0;
  // `pair`: terminal + column width to keep constant (a column-grip drag), so the terminal gives
  // exactly what the column takes; otherwise the terminal only shrinks when the row runs out of room.
  function setWidth(want, pair = 0) {
    const content = $('content'), term = $('term');
    const termOpen = term && term.classList.contains('open');
    const pvCol = $('preview-col'), pvW = pvCol && pvCol.classList.contains('open') ? pvCol.offsetWidth + 4 : 0;
    const room = content.clientWidth - ROSTER_MIN - GRIPS - pvW - (termOpen ? TERM_MIN : 0);
    const w = Math.max(280, Math.min(room, Math.round(want)));
    refs.col.style.width = w + 'px';
    if (!termOpen) return;
    if (!termWanted) termWanted = term.offsetWidth;
    const termRoom = content.clientWidth - ROSTER_MIN - GRIPS - pvW - w;
    const target = pair ? pair - w : termWanted;
    const tw = Math.max(TERM_MIN, Math.min(target, termRoom));
    if (tw !== term.offsetWidth) term.style.width = tw + 'px';
  }
  // While the terminal's own grip is dragged: the column narrows (down to its minimum) so the row
  // never overflows; the terminal's drag limit already reserves that minimum (reserve()).
  const DOC_MIN = 280;
  function reserve() { return visible ? DOC_MIN + 4 : 0; }
  function onTermResized() {
    if (!visible) return;
    const content = $('content'), term = $('term');
    const pvCol = $('preview-col'), pvW = pvCol && pvCol.classList.contains('open') ? pvCol.offsetWidth + 4 : 0;
    const docRoom = content.clientWidth - ROSTER_MIN - GRIPS - pvW - term.offsetWidth;
    if (refs.col.offsetWidth > docRoom) refs.col.style.width = Math.max(DOC_MIN, docRoom) + 'px';
  }
  // ── Column ─────────────────────────────────────────────────────────────────────────
  function setVisible(on) {
    if (visible === on) return;
    visible = on;
    const content = $('content');
    refs.col.classList.toggle('open', on); refs.handle.classList.toggle('open', on);
    refs.btn.classList.toggle('active', on); content.classList.toggle('doc-open', on);
    try { localStorage.setItem('overlord-doc-open', on ? '1' : '0'); } catch {}
    if (on) fitBeside(); else unfit();
    window.dispatchEvent(new Event('resize'));
  }
  // The terminal width the column borrowed, given back when the column closes — unless the user
  // resized the terminal meanwhile, in which case their size stands.
  function unfit() {
    const term = $('term');
    if (termWanted && term && term.classList.contains('open') && term.offsetWidth < termWanted) term.style.width = termWanted + 'px';
    termWanted = 0;
  }
  function toggle() {
    if (visible) { hiddenByUser = order.length > 0; setVisible(false); return; }
    hiddenByUser = false;
    setVisible(true);
    const want = followPending && docs.has(followPending) ? followPending : null; followPending = null;
    if (want) select(want); else if (!selected && order.length) select(order[order.length - 1]);
  }
  // Opening the column must leave the roster readable: if the terminal plus the column would
  // squeeze it under 200px, the terminal gives way (its own saved width is untouched).
  function fitBeside() {
    const content = $('content'), term = $('term');
    termWanted = term && term.classList.contains('open') ? term.offsetWidth : 0;
    setWidth(refs.col.style.width ? parseInt(refs.col.style.width, 10) : Math.max(320, Math.floor(content.clientWidth * 0.38)));
  }

  // ── Tabs ───────────────────────────────────────────────────────────────────────────
  function renderTabs() {
    let h = '';
    const titles = new Map(); for (const p of order) { const d = docs.get(p); if (d) titles.set(d.title, (titles.get(d.title) || 0) + 1); }
    for (const p of order) {
      const d = docs.get(p); if (!d) continue;
      const label = titles.get(d.title) > 1 ? baseOf(p) : d.title; // two "Plan"s: show file names instead
      h += `<div class="doc-tab${p === selected ? ' active' : ''}${d.gone ? ' gone' : ''}" role="tab" aria-selected="${p === selected}" draggable="true" data-path="${escAttr(p)}" title="${escAttr(p)}" onclick="docsUi.select(this.dataset.path)" oncontextmenu="event.preventDefault();docsUi.menu(event,this.dataset.path)">`
        + (d.changedAt && Date.now() - d.changedAt < 60000 ? '<span class="doc-live" title="Changed on disk"></span>' : '')
        + `<span class="doc-tab-name">${esc(label)}</span>`
        + `<button class="doc-x" onclick="event.stopPropagation();docsUi.close(this.parentNode.dataset.path)" title="Close" aria-label="Close document">&times;</button></div>`;
    }
    refs.tablist.innerHTML = h;
    const n = $('doc-toggle-n'); if (n) n.textContent = order.length || '';
    const act = refs.tablist.querySelector('.doc-tab.active'); if (act) act.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    refs.empty.hidden = !!selected;
    refs.view.hidden = !selected || editing; refs.meta.hidden = !selected || editing || !refs.meta.innerHTML;
    refs.editor.hidden = !selected || !editing; refs.scroll.hidden = !!selected && editing;
    refs.editBtn.classList.toggle('active', editing); refs.editBtn.disabled = !selected;
    refs.pathBar.hidden = !selected;
    if (selected) refs.pathText.textContent = selected;
  }

  // "+" offers a fresh note or the file picker.
  function addMenu(e) {
    popMenu(e.clientX, e.clientY, [
      { label: 'New note', hint: 'a markdown file in your notes folder, opened for writing', action: newNote },
      { label: 'Open .md…', action: pick },
    ]);
  }
  function newNote() { api.send({ type: 'docNew' }); }
  function copyPath() { if (selected) navigator.clipboard.writeText(selected).then(() => showToast('Path copied')); }

  // ── Editor ─────────────────────────────────────────────────────────────────────────
  function flushSave() {
    clearTimeout(saveTimer); saveTimer = 0;
    if (!dirty) return;
    dirty = false;
    const d = docs.get(selected); if (!d) return;
    d.title = docTitle(d.text, d.path);
    api.send({ type: 'docWrite', path: d.path, text: d.text });
    renderTabs();
  }
  function setEditing(on, { caretEnd = false } = {}) {
    if (editing && !on) flushSave();
    editing = on;
    const d = docs.get(selected);
    if (d && on) {
      refs.editor.value = d.text;
      renderTabs();
      refs.editor.scrollTop = d.editScrollTop || 0;
      refs.editor.focus(); focused = true;
      if (caretEnd) { const n = refs.editor.value.length; refs.editor.setSelectionRange(n, n); }
    } else if (d) {
      renderDoc(d); renderTabs();
      refs.scroll.scrollTop = d.scrollTop || 0;
    } else renderTabs();
  }
  function toggleEdit() { if (!selected) return; setVisible(true); setEditing(!editing); }
  function setZoom(z, silent) {
    zoom = Math.max(0.6, Math.min(2, Math.round(z * 10) / 10));
    refs.col.style.setProperty('--md-zoom', zoom);
    try { localStorage.setItem('overlord-doc-zoom', String(zoom)); } catch {}
    if (!silent) showToast(`Text ${Math.round(zoom * 100)}%`);
  }

  function menu(e, p) {
    popMenu(e.clientX, e.clientY, [
      { label: 'Edit', action: () => { select(p); setEditing(true); } },
      { label: 'Show in folder', action: () => api.send({ type: 'docReveal', path: p }) },
      { label: 'Open in your editor', action: () => api.send({ type: 'docOpenWith', path: p }) },
      { label: 'Copy path', action: () => { navigator.clipboard.writeText(p).then(() => showToast('Path copied')); } },
      { label: 'Send path to the agent', action: () => sendToAgent(p) },
      { sep: true },
      { label: 'Close', action: () => close(p) },
      { label: 'Close others', action: () => { for (const q of order.slice()) if (q !== p) close(q); } },
    ]);
  }
  function popMenu(x, y, items) {
    const old = $('agent-ctx-menu'); if (old) old.remove();
    const m = document.createElement('div');
    m.id = 'agent-ctx-menu';
    m.style.cssText = 'position:fixed;z-index:9999;background:var(--bg3);border:1px solid var(--border-hi);box-shadow:0 4px 16px rgba(0,0,0,.3);border-radius:6px;padding:4px 0;min-width:170px;';
    m.style.left = x + 'px'; m.style.top = y + 'px';
    for (const it of items) {
      if (it.sep) { const hr = document.createElement('div'); hr.style.cssText = 'height:1px;background:var(--border);margin:3px 0;'; m.appendChild(hr); continue; }
      const b = document.createElement('button'); b.textContent = it.label;
      if (it.hint) { const s = document.createElement('small'); s.textContent = it.hint; s.style.cssText = 'display:block;font-size:10px;color:var(--dim);margin-top:1px;'; b.appendChild(s); }
      b.style.cssText = 'display:block;width:100%;text-align:left;font-family:inherit;font-size:12px;padding:5px 12px;background:none;border:none;color:var(--text);cursor:pointer;';
      b.onmouseenter = () => { b.style.background = 'var(--hover-strong)'; }; b.onmouseleave = () => { b.style.background = 'none'; };
      b.onclick = () => { m.remove(); it.action(); };
      m.appendChild(b);
    }
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    if (r.right > window.innerWidth) m.style.left = (window.innerWidth - r.width - 8) + 'px';
    if (r.bottom > window.innerHeight) m.style.top = (window.innerHeight - r.height - 8) + 'px';
    const off = (ev) => { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('mousedown', off); } };
    setTimeout(() => document.addEventListener('mousedown', off), 0);
  }
  function sendToAgent(p) {
    if (selectedId == null || !agents.has(selectedId)) { showToast('No agent selected'); return; }
    api.send({ type: 'dropPaths', paths: [p], activeAgent: selectedId });
    showToast('Path sent to the agent');
  }

  // ── Showing a document ──────────────────────────────────────────────────────────────
  function select(p, { hash = '' } = {}) {
    const d = docs.get(p); if (!d) return;
    if (selected !== p) {
      flushSave();
      const prev = docs.get(selected); if (prev) { prev.scrollTop = refs.scroll.scrollTop; prev.editScrollTop = refs.editor.scrollTop; }
      selected = p;
      closeFind();
      try { localStorage.setItem('overlord-doc-selected', p); } catch {}
    }
    setVisible(true);
    if (editing) { refs.editor.value = d.text; refs.editor.scrollTop = d.editScrollTop || 0; renderTabs(); return; }
    renderDoc(d);
    if (hash) scrollToId(hash); else refs.scroll.scrollTop = d.scrollTop || 0;
    renderTabs();
  }

  function renderDoc(d) {
    const { meta: fm, body } = splitFrontMatter(d.text);
    refs.meta.innerHTML = fm ? '<table class="md-fm">' + fm.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('') + '</table>' : '';
    refs.meta.hidden = !fm;
    refs.view.innerHTML = toHtml(body, d.path);
    for (const box of refs.view.querySelectorAll('input[type=checkbox]')) box.disabled = false; // marked emits them disabled; here they edit the file
    setBlockDirs(refs.view);
    refs.view.classList.toggle('gone', !!d.gone);
    refs.view.hidden = false;
    if (outlineOpen) renderOutline();
    const up = refs.updated;
    if (d.changedAt) { up.textContent = 'updated ' + ago(d.changedAt); up.classList.add('on'); clearTimeout(up._t); up._t = setTimeout(() => up.classList.remove('on'), 4000); }
    else { up.textContent = ''; up.classList.remove('on'); }
    if (find.q) runFind(find.q);
  }
  // Each block reads in the direction of its first strong letter (dir="rtl" on a Hebrew paragraph
  // puts its bullet, quote bar and alignment on the right); the CSS unicode-bidi:plaintext covers
  // the inline text itself.
  const RTL_RE = /[֐-ࣿיִ-﷿ﹰ-﻿]/, STRONG_RE = /[\p{L}]/u;
  function setBlockDirs(view) {
    for (const el of view.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, dd, dt')) {
      const m = STRONG_RE.exec(el.textContent); if (!m) continue;
      if (RTL_RE.test(m[0])) el.setAttribute('dir', 'rtl');
    }
    for (const l of view.querySelectorAll('ul, ol')) { const first = l.querySelector(':scope > li'); if (first && first.getAttribute('dir') === 'rtl') l.setAttribute('dir', 'rtl'); }
  }
  function ago(t) { const s = Math.round((Date.now() - t) / 1000); return s < 5 ? 'just now' : s < 60 ? s + 's ago' : Math.round(s / 60) + 'm ago'; }

  // marked → HTML, with GitHub heading ids, highlighted fences with a copy button, images
  // beside the file, and every link carrying its raw target for classifyHref at click time.
  const URI_RE = /^(?:(?:https?|mailto|tel|file|data):|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i;
  function toHtml(src, docPath) {
    const seen = new Map();
    const r = new marked.Renderer();
    const plain = (tokens) => tokens.map(t => t.tokens ? plain(t.tokens) : (t.text != null ? t.text : t.raw || '')).join('');
    r.heading = function ({ tokens, depth }) {
      const id = slug(plain(tokens), seen);
      return `<h${depth} id="${escAttr(id)}">${this.parser.parseInline(tokens)}<a class="md-anchor" href="#${escAttr(id)}" aria-label="Link to this section">#</a></h${depth}>\n`;
    };
    r.code = function ({ text, lang }) {
      const l = String(lang || '').trim().split(/\s+/)[0].toLowerCase();
      let out, cls = '';
      if (l && hljs.getLanguage(l)) { try { out = hljs.highlight(text, { language: l, ignoreIllegals: true }).value; cls = ' language-' + l; } catch { out = null; } }
      if (out == null) out = esc(text);
      return `<div class="md-code"><div class="md-code-head"><span>${esc(l || 'text')}</span><button class="md-copy" type="button">Copy</button></div><pre><code class="hljs${cls}">${out}</code></pre></div>\n`;
    };
    r.image = function ({ href, title, text }) {
      return `<img src="${escAttr(assetUrl(href, docPath))}" alt="${escAttr(text || '')}"${title ? ` title="${escAttr(title)}"` : ''} loading="lazy">`;
    };
    r.link = function ({ href, title, tokens }) {
      const body = this.parser.parseInline(tokens);
      return `<a href="${escAttr(href)}" data-href="${escAttr(href)}"${title ? ` title="${escAttr(title)}"` : ''}>${body}</a>`;
    };
    let html;
    try { html = marked.parse(src, { gfm: true, breaks: false, renderer: r }); }
    catch (e) { html = '<pre>' + esc(src) + '</pre>'; }
    return DOMPurify.sanitize(html, { ALLOWED_URI_REGEXP: URI_RE, FORBID_TAGS: ['style', 'form', 'iframe', 'object', 'embed', 'base', 'meta', 'link'], FORBID_ATTR: ['style'] });
  }

  function onViewClick(e) {
    const copy = e.target.closest('.md-copy');
    if (copy) {
      const code = copy.closest('.md-code').querySelector('code');
      navigator.clipboard.writeText(code.textContent).then(() => { copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1200); });
      return;
    }
    const a = e.target.closest('a[href]');
    if (!a) return;
    e.preventDefault();
    const d = docs.get(selected);
    const c = classifyHref(a.dataset.href || a.getAttribute('href'), d ? d.path : '');
    if (c.kind === 'anchor') scrollToId(c.id);
    else if (c.kind === 'external') api.send({ type: 'openUrl', url: c.url });
    else if (c.kind === 'doc') { pendingHash.set(c.path, c.hash || ''); api.send({ type: 'docOpen', paths: [c.path] }); }
    else if (c.kind === 'file') api.send({ type: 'docOpenWith', path: c.path });
  }
  function scrollToId(id) {
    if (!id) return;
    const el = refs.view.querySelector('#' + CSS.escape(id)) || refs.view.querySelector('#' + CSS.escape(slug(id)));
    if (!el) return;
    refs.scroll.scrollTop = el.offsetTop - 12;
    el.classList.add('md-flash'); setTimeout(() => el.classList.remove('md-flash'), 1200);
  }

  // ── Outline ────────────────────────────────────────────────────────────────────────
  function setOutline(on) { outlineOpen = on; $('doc-outline').hidden = !on; $('doc-outline-btn').classList.toggle('active', on); if (on) renderOutline(); }
  function toggleOutline() { setOutline(!outlineOpen); }
  function renderOutline() {
    const hs = [...refs.view.querySelectorAll('h1, h2, h3, h4')];
    $('doc-outline').innerHTML = hs.length ? hs.map(h => `<a href="#" data-id="${escAttr(h.id)}" class="ol-${h.tagName.toLowerCase()}">${esc(h.textContent.replace(/#$/, ''))}</a>`).join('') : '<em>No headings</em>';
  }

  // ── Find ───────────────────────────────────────────────────────────────────────────
  function openFind() { if (!selected) return; setVisible(true); if (editing) setEditing(false); $('doc-find').hidden = false; const i = $('doc-find-input'); i.focus(); i.select(); focused = true; if (i.value) runFind(i.value); }
  function closeFind() { $('doc-find').hidden = true; clearMarks(); find = { q: '', marks: [], i: -1 }; $('doc-find-input').value = ''; $('doc-find-count').textContent = ''; }
  function clearMarks() {
    for (const m of find.marks) { const t = document.createTextNode(m.textContent); m.replaceWith(t); if (t.parentNode) t.parentNode.normalize(); }
    find.marks = [];
  }
  function runFind(q) {
    clearMarks();
    find.q = q; find.i = -1;
    if (!q) { $('doc-find-count').textContent = ''; return; }
    const lq = q.toLowerCase();
    const walker = document.createTreeWalker(refs.view, NodeFilter.SHOW_TEXT);
    const hits = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const s = n.nodeValue, ls = s.toLowerCase(); let at = ls.indexOf(lq, 0);
      if (at < 0) continue;
      const ranges = []; while (at >= 0) { ranges.push(at); at = ls.indexOf(lq, at + lq.length); }
      hits.push([n, ranges]);
    }
    for (const [n, ranges] of hits) {
      let node = n, offset = 0;
      for (const at of ranges) {
        const m = document.createElement('mark'); m.className = 'md-hit';
        const r = document.createRange(); r.setStart(node, at - offset); r.setEnd(node, at - offset + q.length);
        try { r.surroundContents(m); } catch { continue; }
        find.marks.push(m);
        node = m.nextSibling; offset = at + q.length;
        if (!node) break;
      }
    }
    $('doc-find-count').textContent = find.marks.length ? '' : 'No matches';
    if (find.marks.length) findStep(1);
  }
  function findStep(dir) {
    if (!find.marks.length) return;
    if (find.i >= 0) find.marks[find.i].classList.remove('cur');
    find.i = (find.i + dir + find.marks.length) % find.marks.length;
    const m = find.marks[find.i]; m.classList.add('cur');
    m.scrollIntoView({ block: 'center' });
    $('doc-find-count').textContent = `${find.i + 1}/${find.marks.length}`;
  }

  // ── Follow the agent ─────────────────────────────────────────────────────────────────
  function toggleFollow() { follow = !follow; refs.followBtn.classList.toggle('active', follow); try { localStorage.setItem('overlord-doc-follow', follow ? '1' : '0'); } catch {} showToast(follow ? 'Following: the focused agent\'s .md edits open here' : 'Follow off'); }
  // A Write/Edit of an .md by the focused agent just finished: show that file (the watcher keeps it
  // current from here). Other agents' edits are left alone; the user is reading along with one.
  // While the column is hidden by hand, the file is added as a tab (the header badge ticks up and
  // pulses) and shown once the column is opened again, instead of popping the column back open.
  function onToolFile(agentId, toolName, file) {
    if (!follow || agentId !== selectedId || !file || !MD_RE.test(file)) return;
    if (!/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(toolName || '')) return;
    const quietAdd = !visible && hiddenByUser;
    if (quietAdd) { followPending = file; refs.btn.classList.remove('pulse'); void refs.btn.offsetWidth; refs.btn.classList.add('pulse'); }
    api.send({ type: 'docOpen', paths: [file], select: !quietAdd, quiet: true });
  }

  // ── Open / close / messages ────────────────────────────────────────────────────────
  function close(p) {
    if (!docs.has(p)) return;
    const wasShown = selected === p;
    const next = wasShown ? nextAfterClose(order, p) : null;
    if (wasShown) flushSave();
    docs.delete(p); order = withoutDoc(order, p);
    if (followPending === p) followPending = null;
    api.send({ type: 'docClose', path: p });
    if (wasShown) {
      selected = null; closeFind(); setOutline(false);
      if (next) select(next); else { refs.view.innerHTML = ''; refs.meta.innerHTML = ''; refs.updated.textContent = ''; refs.editor.value = ''; editing = false; }
    }
    renderTabs();
    if (!order.length) { hiddenByUser = false; setVisible(false); }
  }
  function closeSelected() { if (selected && visible) { close(selected); return true; } return false; }
  function cycle(dir) {
    if (!visible || !order.length) return false;
    const i = order.indexOf(selected);
    const n = dir < 0 ? (i <= 0 ? order.length - 1 : i - 1) : (i < 0 || i >= order.length - 1 ? 0 : i + 1);
    select(order[n]); return true;
  }
  const hasFocus = () => visible && focused;

  function onMsg(msg) {
    if (msg.type === 'docOpen') {
      const fresh = !docs.has(msg.path);
      const d = docs.get(msg.path) || { path: msg.path, scrollTop: 0, changedAt: 0 };
      d.text = msg.text; d.mtime = msg.mtime; d.title = docTitle(msg.text, msg.path); d.gone = false;
      docs.set(msg.path, d); if (fresh) order = [...order, msg.path];
      if (msg.select) {
        const hash = pendingHash.get(msg.path) || ''; pendingHash.delete(msg.path);
        hiddenByUser = false;
        if (editing && !msg.edit) setEditing(false);
        select(msg.path, { hash });
        if (msg.edit) setEditing(true, { caretEnd: true });
        requestAnimationFrame(() => api.send({ type: 'docShown', path: msg.path, t0: msg.t0 || 0, where: msg.t0 ? (fresh ? 'open' : 'reopen') : 'page' }));
      } else {
        if (!fresh && selected === msg.path) renderDoc(d);
        renderTabs();
        // Restored documents reopen the column on the tab shown last time, without stealing the pane width twice.
        if (fresh && !selected) { let last = '', wasOpen = false; try { last = localStorage.getItem('overlord-doc-selected') || ''; wasOpen = localStorage.getItem('overlord-doc-open') === '1'; } catch {} if (wasOpen && (last === msg.path || !docs.has(last))) select(msg.path); }
      }
      return true;
    }
    if (msg.type === 'docChange') {
      const d = docs.get(msg.path); if (!d) return true;
      if (selected === msg.path && editing) {
        // Our own save coming back, or unsaved typing in flight: the editor's text stands. Someone
        // else's edit while the editor is clean: take it, keeping the caret where it was.
        if (msg.text === d.text || dirty) { d.mtime = msg.mtime; return true; }
        const t = refs.editor, s = t.selectionStart, e = t.selectionEnd;
        d.text = msg.text; d.mtime = msg.mtime; d.changedAt = Date.now(); d.title = docTitle(msg.text, msg.path); d.gone = false;
        t.value = msg.text; try { t.setSelectionRange(Math.min(s, t.value.length), Math.min(e, t.value.length)); } catch {}
        renderTabs(); scheduleDotFade(); return true;
      }
      d.text = msg.text; d.mtime = msg.mtime; d.changedAt = Date.now(); d.title = docTitle(msg.text, msg.path); d.gone = false;
      if (selected === msg.path) {
        const sc = refs.scroll;
        const atBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 8, top = sc.scrollTop;
        renderDoc(d);
        sc.scrollTop = atBottom ? sc.scrollHeight : top;
      }
      renderTabs();
      scheduleDotFade();
      return true;
    }
    if (msg.type === 'docGone') { const d = docs.get(msg.path); if (d) { d.gone = true; renderTabs(); if (selected === msg.path) renderDoc(d); } return true; }
    if (msg.type === 'docAssociated') { const b = $('doc-assoc-btn'); if (b) b.textContent = msg.ok ? '✓ Registered' : 'Set Overlord as the .md viewer'; return true; }
    return false;
  }

  let dotTimer = 0;
  function scheduleDotFade() { clearTimeout(dotTimer); dotTimer = setTimeout(renderTabs, 61000); } // the "changed" dot fades a minute after the last change
  function reveal() { if (selected) api.send({ type: 'docReveal', path: selected }); }
  function openWith() { if (selected) api.send({ type: 'docOpenWith', path: selected }); }
  function pick() { const a = typeof agents !== 'undefined' && agents.get(selectedId); api.send({ type: 'docPick', dir: (a && a.cwd) || '' }); } // the picker starts in the focused agent's folder
  function associate() { const b = $('doc-assoc-btn'); if (b) b.textContent = 'Registering…'; api.send({ type: 'docAssociate' }); }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
  window.addEventListener('beforeunload', flushSave);
  window.docsUi = { onMsg, onToolFile, select, close, closeSelected, cycle, toggle, hasFocus, menu, addMenu, newNote, copyPath, toggleEdit, reveal, openWith, pick, associate, openFind, closeFind, findStep, toggleOutline, toggleFollow, reserve, onTermResized,
    isVisible: () => visible, count: () => docs.size, selected: () => selected };
})();
