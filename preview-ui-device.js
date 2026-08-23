// Device emulation (Desktop / Mobile / iPad) + portrait/landscape for the preview pane.
// Exposes window.PreviewDevice.create({ send, onChange }) → { getBounds, applyUi, showMenu, current }.
(function () {
  const SIZES = { desktop: null, mobile: [390, 844], ipad: [820, 1180] };
  const ICONS = { desktop: '&#x1F5A5;', mobile: '&#x1F4F1;', ipad: '&#x1F4DF;' };

  // Device choice is per agent. One shared variable meant setting agent 1 to
  // mobile left the toolbar reading "mobile" for agent 2, whose view was still
  // rendering desktop — and sized the pane bounds for the wrong device.
  function create({ send, onChange }) {
    const byAgent = new Map(); // agentId -> { device, landscape }
    let agentId = null;
    let refs = null;

    const state = () => byAgent.get(agentId) || { device: 'desktop', landscape: false };
    const device = () => state().device;
    const landscape = () => state().landscape;
    const setState = (patch) => { if (agentId != null) byAgent.set(agentId, { ...state(), ...patch }); };

    function bind(r) { refs = r; applyUi(); }

    function setAgent(id) {
      if (id === agentId) return;
      agentId = id;
      applyUi();
      onChange();
    }

    function getBounds(r) {
      const size = SIZES[device()];
      if (!size) return { x: r.left, y: r.top, width: r.width, height: r.height };
      const [pw, ph] = landscape() ? [size[1], size[0]] : size;
      const w = Math.min(pw, Math.max(280, r.width - 16));
      const h = Math.min(ph, r.height);
      return { x: r.left + (r.width - w) / 2, y: r.top + Math.max(0, (r.height - h) / 2), width: w, height: h };
    }

    function applyUi() {
      if (!refs) return;
      const d = device();
      refs.deviceBtn.innerHTML = ICONS[d];
      refs.deviceBtn.title = `Device: ${d} (click to change)`;
      refs.deviceBtn.classList.toggle('active', d !== 'desktop');
      refs.rotateBtn.style.display = (d === 'desktop') ? 'none' : '';
      refs.rotateBtn.classList.toggle('active', landscape());
    }

    function setDevice(d) {
      if (!(d in SIZES) || d === device() || agentId == null) return;
      setState({ device: d, landscape: d === 'desktop' ? false : landscape() });
      applyUi();
      send({ type: 'previewSetDevice', device: d });
      onChange();
    }

    function toggleOrientation() {
      if (device() === 'desktop') return;
      setState({ landscape: !landscape() });
      applyUi();
      onChange();
    }

    function showMenu(e) {
      e.stopPropagation();
      const old = document.getElementById('preview-device-menu');
      if (old) { old.remove(); return; }
      const menu = document.createElement('div');
      menu.id = 'preview-device-menu';
      for (const [d, label] of [['desktop','Desktop'],['mobile','Mobile'],['ipad','iPad']]) {
        const btn = document.createElement('button');
        btn.innerHTML = `${ICONS[d]} ${label}${device() === d ? ' &#x2713;' : ''}`;
        btn.onclick = () => { menu.remove(); setDevice(d); };
        menu.appendChild(btn);
      }
      document.body.appendChild(menu);
      const r = refs.deviceBtn.getBoundingClientRect();
      menu.style.left = r.left + 'px'; menu.style.top = (r.bottom + 4) + 'px';
      const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', close); } };
      setTimeout(() => document.addEventListener('mousedown', close), 0);
    }

    return { bind, setAgent, getBounds, applyUi, showMenu, toggleOrientation };
  }

  window.PreviewDevice = { create };
})();
