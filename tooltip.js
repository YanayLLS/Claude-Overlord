// One tooltip for the whole app. Any element with a title (or data-tip) gets a
// dark bubble with an arrow pointing at it, opening toward whichever side of
// the screen has the most room. The title is moved to data-tip on first hover
// so the native tooltip never shows alongside it.

const TIP_GAP = 8;      // room for the arrow between target and bubble
const TIP_MARGIN = 6;   // bubble never touches the window edge
const TIP_ARROW_PAD = 10; // arrow stays clear of the bubble's rounded corners

const tipClamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// r: target rect, w/h: bubble size, vw/vh: window size.
// Returns bubble position, the side it opened on, and the arrow offset along
// the bubble's edge (x for top/bottom, y for left/right).
function tipPlacement(r, w, h, vw, vh) {
  const room = { top: r.top, bottom: vh - r.bottom, left: r.left, right: vw - r.right };
  const fits = { top: room.top >= h + TIP_GAP, bottom: room.bottom >= h + TIP_GAP, left: room.left >= w + TIP_GAP, right: room.right >= w + TIP_GAP };
  const sides = ['top', 'bottom', 'right', 'left'];
  const pool = sides.some(s => fits[s]) ? sides.filter(s => fits[s]) : sides;
  const side = pool.reduce((best, s) => (room[s] > room[best] ? s : best), pool[0]);
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  if (side === 'top' || side === 'bottom') {
    const x = tipClamp(cx - w / 2, TIP_MARGIN, vw - w - TIP_MARGIN);
    const y = side === 'top' ? r.top - h - TIP_GAP : r.bottom + TIP_GAP;
    return { side, x, y, arrow: tipClamp(cx - x, TIP_ARROW_PAD, w - TIP_ARROW_PAD) };
  }
  const y = tipClamp(cy - h / 2, TIP_MARGIN, vh - h - TIP_MARGIN);
  const x = side === 'left' ? r.left - w - TIP_GAP : r.right + TIP_GAP;
  return { side, x, y, arrow: tipClamp(cy - y, TIP_ARROW_PAD, h - TIP_ARROW_PAD) };
}

if (typeof document !== 'undefined') {
  const tipEl = document.createElement('div');
  tipEl.id = 'app-tip';
  tipEl.setAttribute('role', 'tooltip');
  let tipTarget = null, tipTimer = null;

  // The text lives in data-tip; a title (set in HTML or later by code) is moved there.
  const tipText = (el) => {
    const t = el.getAttribute('title');
    if (t != null) { el.dataset.tip = t; el.removeAttribute('title'); }
    return el.dataset.tip || '';
  };
  const hideTip = () => { clearTimeout(tipTimer); tipTarget = null; tipEl.classList.remove('show'); };
  const showTip = (el) => {
    const text = tipText(el);
    if (!text || !el.isConnected) return;
    if (!tipEl.isConnected) document.body.appendChild(tipEl);
    tipEl.textContent = text;
    tipEl.className = ''; tipEl.style.left = '0px'; tipEl.style.top = '0px'; // measure at rest
    const b = tipEl.getBoundingClientRect();
    const p = tipPlacement(el.getBoundingClientRect(), b.width, b.height, innerWidth, innerHeight);
    tipEl.style.left = p.x + 'px'; tipEl.style.top = p.y + 'px';
    tipEl.style.setProperty('--arrow', p.arrow + 'px');
    tipEl.className = 'show ' + p.side;
  };

  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest && e.target.closest('[title], [data-tip]');
    if (el === tipTarget) return;
    hideTip();
    if (!el) return;
    tipText(el); // strip the title now so the native tooltip can't race ours
    tipTarget = el;
    tipTimer = setTimeout(() => { if (tipTarget === el) showTip(el); }, 350);
  });
  // Titles some rows set on mouseenter land after mouseover; catch them before the native tip does.
  document.addEventListener('mousemove', () => { if (tipTarget && tipTarget.hasAttribute('title')) tipText(tipTarget); }, { passive: true });
  for (const ev of ['mousedown', 'wheel', 'keydown', 'blur']) window.addEventListener(ev, hideTip, { capture: true, passive: true });
  document.addEventListener('mouseleave', hideTip);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { tipPlacement };
}
