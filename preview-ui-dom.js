// DOM construction + drag-resize for the preview pane.
// Exposes window.PreviewDom = { build, setupResize }.
(function () {
  function build(actions) {
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'hdr-btn'; toggleBtn.id = 'preview-toggle';
    toggleBtn.title = 'Toggle web preview'; toggleBtn.textContent = '⧉';
    toggleBtn.onclick = actions.onToggle;
    const header = document.getElementById('header');
    header.insertBefore(toggleBtn, document.getElementById('addBtn'));

    const content = document.getElementById('content');
    const handle = document.createElement('div');
    handle.id = 'preview-resize';
    content.appendChild(handle);

    const col = document.createElement('div');
    col.id = 'preview-col';
    col.innerHTML = `
      <div id="preview-header">
        <input id="preview-url" type="text" spellcheck="false" placeholder="Enter URL or wait for localhost…" />
        <button id="preview-device" title="Device">&#x1F5A5;</button>
        <button id="preview-rotate" title="Rotate orientation" style="display:none">&#x21BB;&#x1F4D0;</button>
        <button id="preview-reload" title="Reload">&#x21BB;</button>
        <button id="preview-close" title="Hide preview">&times;</button>
      </div>
      <div id="preview-host"></div>
      <div id="preview-status">Waiting for localhost…</div>
      <div id="preview-errors">
        <span id="preview-error-badge">0 errors</span>
        <button id="preview-send" disabled>Send to agent</button>
        <button id="preview-clear" disabled>Clear</button>
      </div>`;
    content.appendChild(col);

    const refs = {
      toggleBtn, col, handle,
      host: col.querySelector('#preview-host'),
      urlInput: col.querySelector('#preview-url'),
      statusEl: col.querySelector('#preview-status'),
      errorBadge: col.querySelector('#preview-error-badge'),
      sendBtn: col.querySelector('#preview-send'),
      clearBtn: col.querySelector('#preview-clear'),
      deviceBtn: col.querySelector('#preview-device'),
      rotateBtn: col.querySelector('#preview-rotate'),
    };
    col.querySelector('#preview-reload').onclick = actions.onReload;
    col.querySelector('#preview-close').onclick = actions.onToggle;
    refs.deviceBtn.onclick = actions.onDevice;
    refs.rotateBtn.onclick = actions.onRotate;
    refs.sendBtn.onclick = actions.onSend;
    refs.clearBtn.onclick = actions.onClear;
    refs.urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); actions.onNavigate(refs.urlInput.value.trim()); }
    });
    refs.urlInput.addEventListener('focus', () => refs.urlInput.select());
    return refs;
  }

  function setupResize(handle, col, onChange) {
    let dragging = false, startX = 0, startW = 0;
    handle.addEventListener('mousedown', (e) => {
      dragging = true; startX = e.clientX; startW = col.offsetWidth;
      document.body.style.userSelect = 'none';
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const w = Math.max(280, Math.min(window.innerWidth - 400, startW - (e.clientX - startX)));
      col.style.width = w + 'px';
      onChange();
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false; document.body.style.userSelect = '';
    });
  }

  window.PreviewDom = { build, setupResize };
})();
