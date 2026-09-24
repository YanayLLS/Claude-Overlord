// One tooltip for the whole app. Any element with a title (or data-tip) gets a
// dark bubble with an arrow pointing at it, opening toward whichever side of
// the screen has the most room. Titles are moved to data-tip as soon as they
// appear, so the native tooltip never shows alongside it.

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
  // A cut-off name doesn't get a bubble: the row itself grows past the panel's edge, over the terminal.
  const peekEl = document.createElement('div');
  peekEl.id = 'name-peek';

  // The row's background as one opaque color (hover tints are translucent), so the peek reads as the same row.
  const solidBg = (el) => {
    const layers = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const m = getComputedStyle(n).backgroundColor.match(/[\d.]+/g);
      const a = m && m[3] != null ? +m[3] : 1;
      if (!m || a === 0) continue;
      layers.push([+m[0], +m[1], +m[2], a]);
      if (a === 1) break;
    }
    let c = [0, 0, 0];
    for (const [r, g, b, a] of layers.reverse()) c = [c[0] * (1 - a) + r * a, c[1] * (1 - a) + g * a, c[2] * (1 - a) + b * a];
    return `rgb(${c.map(Math.round).join(',')})`;
  };
  const showPeek = (el) => {
    const row = el.closest('.agent') || el.parentElement;
    const r = el.getBoundingClientRect(), rr = row.getBoundingClientRect(), cs = getComputedStyle(el);
    if (!peekEl.isConnected) document.body.appendChild(peekEl);
    peekEl.textContent = el.textContent;
    Object.assign(peekEl.style, {
      left: r.left + 'px', top: rr.top + 'px', height: rr.height + 'px', lineHeight: rr.height + 'px', maxWidth: (innerWidth - r.left - 6) + 'px',
      fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight, letterSpacing: cs.letterSpacing, color: cs.color,
      background: solidBg(row),
    });
    peekEl.classList.add('show');
  };

  // The text lives in data-tip. Every title, whether in the HTML, from a re-render, or set by
  // code later, is moved there the moment it appears, so the native tooltip has nothing to show.
  const tipText = (el) => {
    const t = el.getAttribute('title');
    if (t != null) { el.dataset.tip = t; el.removeAttribute('title'); }
    // data-tip-overflow: the element's own text, only while it's cut off with an ellipsis
    if (el.hasAttribute('data-tip-overflow')) return el.scrollWidth > el.clientWidth ? el.textContent : '';
    return el.dataset.tip || '';
  };
  const stripTitles = (root) => {
    if (root.nodeType !== 1) return;
    if (root.hasAttribute('title')) tipText(root);
    for (const el of root.querySelectorAll('[title]')) tipText(el);
  };
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes') {
        if (!m.target.hasAttribute('title')) continue;
        tipText(m.target);
        if (m.target === tipTarget && tipEl.classList.contains('show')) showTip(m.target); // live text, e.g. "updated 5s ago"
      }
      else for (const n of m.addedNodes) stripTitles(n);
    }
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });
  stripTitles(document.documentElement);
  document.addEventListener('DOMContentLoaded', () => stripTitles(document.documentElement));
  const hideTip = () => { clearTimeout(tipTimer); tipTarget = null; tipEl.classList.remove('show'); peekEl.classList.remove('show'); };
  const showTip = (el) => {
    if (el.hasAttribute('data-tip-overflow')) {
      if (el.isConnected && el.scrollWidth > el.clientWidth) showPeek(el); else peekEl.classList.remove('show');
      return;
    }
    const text = tipText(el);
    if (!text || !el.isConnected) { tipEl.classList.remove('show'); return; }
    if (!tipEl.isConnected) document.body.appendChild(tipEl);
    const r = el.getBoundingClientRect(), key = text + '|' + r.left + ',' + r.top + ',' + r.width + ',' + r.height;
    if (tipEl.classList.contains('show') && tipEl.dataset.key === key) return; // same text, same spot: stay put
    tipEl.dataset.key = key;
    tipEl.textContent = text;
    tipEl.style.left = '0px'; tipEl.style.top = '0px'; // measure at rest; classes stay so the fade doesn't restart
    const b = tipEl.getBoundingClientRect();
    const p = tipPlacement(r, b.width, b.height, innerWidth, innerHeight);
    tipEl.style.left = p.x + 'px'; tipEl.style.top = p.y + 'px';
    tipEl.style.setProperty('--arrow', p.arrow + 'px');
    tipEl.className = 'show ' + p.side;
  };

  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest && e.target.closest('[data-tip], [title], [data-tip-overflow]'); // title: a fresh node the observer hasn't reached yet
    if (el === tipTarget) return;
    // A re-render swapped the hovered element for a fresh copy: keep the tip up and follow the new one.
    if (el && tipTarget && !tipTarget.isConnected) {
      tipTarget = el;
      if (tipEl.classList.contains('show') || peekEl.classList.contains('show')) showTip(el);
      return;
    }
    hideTip();
    if (!el) return;
    tipTarget = el;
    // A cut-off name is the whole point of hovering it: show it whole at once. Everything else waits a beat.
    if (el.hasAttribute('data-tip-overflow')) { showTip(el); return; }
    tipTimer = setTimeout(() => { if (tipTarget === el) showTip(el); }, 350);
  });
  for (const ev of ['mousedown', 'wheel', 'keydown']) window.addEventListener(ev, hideTip, { capture: true, passive: true });
  window.addEventListener('blur', hideTip); // the window losing focus, not every element blur a re-render causes
  document.addEventListener('mouseleave', hideTip);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { tipPlacement };
}
