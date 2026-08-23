// Pure DOM serializer. buildSnapshot must reference NOTHING from module scope —
// it is stringified and injected into the page, where that scope does not exist.
// That is why its caps are literals and its helpers are nested rather than
// shared: everything it needs has to travel inside its own source text.
function buildSnapshot(doc) {
  const INTERACTIVE = 'a,button,input,textarea,select,[role=button],[role=link],[onclick],[contenteditable=true]';
  const TEXT = 'h1,h2,h3,h4,h5,h6,p,li,td,th,label,blockquote,figcaption,summary';
  const clean = (raw, max) => String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().slice(0, max);

  function interactiveLines(refs) {
    const lines = [];
    const nodes = doc.querySelectorAll(INTERACTIVE);
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const rect = el.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) continue;
      refs.push(el);
      const label = clean(el.getAttribute('aria-label') || el.value || el.textContent, 80);
      lines.push(el.tagName.toLowerCase() + ' "' + label + '" [ref_' + refs.length + ']');
    }
    return lines;
  }

  // Deliberately bounded: the whole point of a snapshot is that it costs a
  // fraction of a screenshot. Keys are prefixed so a heading reading
  // "__proto__" cannot collide with Object.prototype.
  function visibleText() {
    const seen = {};
    const out = [];
    let budget = 1500;
    const nodes = doc.querySelectorAll(TEXT);
    for (let i = 0; i < nodes.length && budget > 0; i++) {
      const line = clean(nodes[i].textContent, 200);
      if (!line || seen['#' + line]) continue;
      seen['#' + line] = 1;
      out.push(line);
      budget -= line.length + 1;
    }
    return out.join('\n');
  }

  const refs = [];
  const lines = interactiveLines(refs);
  doc.__overlordRefs = refs;
  return {
    title: doc.title || '',
    url: (doc.location && doc.location.href) || '',
    tree: lines.length ? lines.join('\n') : '(no interactive elements)',
    text: visibleText(),
  };
}

function resolveRefPoint(doc, ref) {
  const refs = doc.__overlordRefs || [];
  const el = refs[Number(String(ref).replace('ref_', '')) - 1];
  if (!el || !el.isConnected) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

const SNAPSHOT_SOURCE = `(${buildSnapshot.toString()})(document)`;
const refPointSource = (ref) => `(${resolveRefPoint.toString()})(document, ${JSON.stringify(String(ref))})`;

module.exports = { buildSnapshot, resolveRefPoint, SNAPSHOT_SOURCE, refPointSource };
