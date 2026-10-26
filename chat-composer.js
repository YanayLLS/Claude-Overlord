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
  function onKey(e) {
    const t = e.target;
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
  document.getElementById('chat-plus').addEventListener('click', (e) => { e.stopPropagation(); catalogUi.isOpen() ? catalogUi.close() : openPicker(); });
  document.getElementById('chat-plus').addEventListener('mousedown', (e) => e.stopPropagation()); // the picker's outside-click close would reopen it
  document.getElementById('chat-chips').addEventListener('click', (e) => chatUi.onClick(e, agents.get(selectedId), null));
  window.chatComposer = { send, onKey, onImagePasted, clearAttachments };
})();
