// The Chat view's composer, doing what the CLI's prompt box does: Enter sends (the prompt shows at once, dimmed,
// until the transcript has it), Esc interrupts a working agent, ↑/↓ walk your earlier prompts, "/" or + opens the
// skills/commands picker, a pasted image goes to the agent's prompt as [Image #N] and shows here as a thumbnail.
(function () {
  const box = () => document.getElementById('term-order-input');
  const order = () => document.getElementById('term-order');
  const chat = () => termTab === 'conversation' && !worldView;
  let hist = -1, draft = '';
  const grow = (t) => { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; order().classList.toggle('empty', !t.value.trim()); };

  // questPrompt pastes the text and sends Enter in its own write once the paste has landed: the TUI swallows an Enter
  // written together with the text. Images pasted here already sit in the agent's prompt, so they go with it.
  function send() {
    const inp = box(), text = inp.value.trim(); if (selectedId == null) return;
    if (!text) { if (chat() && order().classList.contains('busy')) chatUi.keys(['\x1b']); return; } // empty + working: Stop
    api.send({ type: 'questPrompt', id: selectedId, text });
    if (chat()) { chatUi.addPending(selectedId, text); clearAttachments(); }
    inp.value = ''; inp.style.height = ''; hist = -1; order().classList.add('empty');
    if (chat()) renderConversation();
  }
  function insert(text, andSend) {
    const t = box(), s = t.selectionStart ?? t.value.length;
    t.value = t.value.slice(0, s) + text + t.value.slice(t.selectionEnd ?? s); t.focus();
    t.selectionStart = t.selectionEnd = s + text.length; grow(t);
    if (andSend) send();
  }
  const openPicker = () => catalogUi.open({ anchor: order(), insert, focus: () => box().focus() });

  function prompts() { const a = agents.get(selectedId); return ((a && a.prompts) || []).map(p => typeof p === 'string' ? p : (p && p.text) || '').filter(Boolean); }
  // ── @file suggestions: typing @name lists matching files in the agent's folder; ↑/↓ pick, Enter/Tab insert ──
  let at = null, atSeq = 0; // { start, files, sel } while the list is open
  const atList = () => document.getElementById('chat-at');
  function atQuery(t) { const m = /(^|\s)@([^\s@]*)$/.exec(t.value.slice(0, t.selectionStart)); return m ? { start: t.selectionStart - m[2].length - 1, q: m[2] } : null; }
  function onInput(e) {
    if (!chat()) return;
    const m = atQuery(e.target), a = agents.get(selectedId);
    if (!m || !a) return closeAt();
    at = { start: m.start, files: at ? at.files : [], sel: 0 };
    api.send({ type: 'chatFiles', id: selectedId, cwd: a.cwd, q: m.q, seq: ++atSeq });
  }
  function onFiles(msg) {
    if (!at || msg.seq !== atSeq || msg.id !== selectedId) return;
    at.files = msg.files || []; at.sel = 0; drawAt();
  }
  function drawAt() {
    const l = atList();
    l.innerHTML = at && at.files.length ? at.files.map((f, k) => { const i = f.lastIndexOf('/'); return `<div class="at-i${k === at.sel ? ' sel' : ''}" data-k="${k}"><b>${f.slice(i + 1).replace(/[&<>]/g, '')}</b><span>${i > 0 ? f.slice(0, i).replace(/[&<>]/g, '') : ''}</span></div>`; }).join('') : '';
    l.classList.toggle('open', !!(at && at.files.length));
  }
  function closeAt() { at = null; drawAt(); }
  function pickAt(k) {
    const t = box(), f = at && at.files[k]; if (!f) return closeAt();
    const end = t.selectionStart, ins = '@' + f + ' ';
    t.value = t.value.slice(0, at.start) + ins + t.value.slice(end); t.selectionStart = t.selectionEnd = at.start + ins.length;
    closeAt(); grow(t); t.focus();
  }

  // With the box empty, a question or permission card takes the terminal's keys: 1–9 pick, Esc denies.
  function cardKey(e) {
    if (box().value) return false;
    const tail = document.querySelector('#conversation .tail');
    if (/^[1-9]$/.test(e.key)) { const b = tail && (tail.querySelector(`[data-pick="${+e.key - 1}"]`) || tail.querySelector(`[data-keys="${e.key}"]`) || tail.querySelectorAll('.choices button')[+e.key - 1]); if (b) { b.click(); return true; } }
    if (e.key === 'Escape') { const b = tail && tail.querySelector('[data-keys="esc"]'); if (b) { b.click(); return true; } }
    return false;
  }

  function onKey(e) {
    const t = e.target;
    if (at && at.files.length && chat()) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); at.sel = (at.sel + (e.key === 'ArrowDown' ? 1 : at.files.length - 1)) % at.files.length; drawAt(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickAt(at.sel); return; }
      if (e.key === 'Escape') { e.preventDefault(); closeAt(); return; }
    }
    if (chat() && cardKey(e)) { e.preventDefault(); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); return; }
    if (!chat()) return;
    if (e.key === 'Escape' && order().classList.contains('busy')) { e.preventDefault(); chatUi.keys(['\x1b']); return; }
    if (e.key === '/' && !t.value) { e.preventDefault(); openPicker(); return; }
    // History, like the CLI: ↑ at the start of the box steps back through your prompts, ↓ comes forward again.
    const ps = prompts();
    if (e.key === 'ArrowUp' && t.selectionStart === 0 && t.selectionEnd === 0 && ps.length) {
      e.preventDefault(); if (hist < 0) draft = t.value;
      hist = Math.min(ps.length - 1, hist + 1); t.value = ps[ps.length - 1 - hist]; grow(t); t.selectionStart = t.selectionEnd = 0;
    } else if (e.key === 'ArrowDown' && hist >= 0 && t.selectionStart === t.value.length) {
      e.preventDefault(); hist--; t.value = hist < 0 ? draft : ps[ps.length - 1 - hist]; grow(t);
    }
  }
  // An image on the clipboard goes through main like Alt+V in the terminal: saved, then pasted into the agent's prompt.
  function onPaste(e) {
    if (!chat() || selectedId == null) return;
    const img = [...(e.clipboardData?.items || [])].find(i => i.kind === 'file' && i.type.startsWith('image/'));
    if (img) { e.preventDefault(); api.send({ type: 'pasteImage', id: selectedId }); }
  }
  // main answers with the saved file: a thumbnail above the box until the prompt is sent.
  function onImagePasted(msg) {
    if (!chat() || msg.id !== selectedId || !msg.path) return;
    const att = document.getElementById('chat-att');
    att.insertAdjacentHTML('beforeend', `<img src="file:///${encodeURI(msg.path.replace(/^\/+/, ''))}" alt="">`);
    order().classList.add('has-att');
  }
  function clearAttachments() { document.getElementById('chat-att').innerHTML = ''; order().classList.remove('has-att'); }

  document.getElementById('term-order-input').addEventListener('paste', onPaste);
  document.getElementById('term-order-input').addEventListener('input', onInput);
  document.getElementById('term-order-input').addEventListener('blur', () => setTimeout(closeAt, 150));
  document.getElementById('chat-at').addEventListener('mousedown', (e) => { const i = e.target.closest('.at-i'); if (i) { e.preventDefault(); pickAt(+i.dataset.k); } });
  document.getElementById('chat-plus').addEventListener('click', (e) => { e.stopPropagation(); catalogUi.isOpen() ? catalogUi.close() : openPicker(); });
  document.getElementById('chat-plus').addEventListener('mousedown', (e) => e.stopPropagation()); // the picker's outside-click close would reopen it
  document.getElementById('chat-chips').addEventListener('click', (e) => chatUi.onClick(e, agents.get(selectedId), null));
  window.chatComposer = { send, insert, onKey, onFiles, onImagePasted, clearAttachments };
})();
