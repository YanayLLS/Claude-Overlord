const test = require('node:test');
const assert = require('node:assert');
const { buildSnapshot, SNAPSHOT_SOURCE, refPointSource, resolveRefPoint } = require('./snapshot-script');

function el(tag, opts = {}) {
  const attrs = opts.attrs || {};
  let scrollIntoViewCalled = false;
  const element = {
    tagName: tag.toUpperCase(),
    textContent: opts.text || '',
    value: opts.value || '',
    isConnected: opts.isConnected !== false,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    getBoundingClientRect: () => opts.rect || { left: 0, top: 0, width: 100, height: 20 },
    scrollIntoView: () => { scrollIntoViewCalled = true; },
    __scrollIntoViewCalled: () => scrollIntoViewCalled,
  };
  return element;
}

// buildSnapshot now runs two different queries over the document, so the stub
// has to answer them separately instead of returning the same array for both.
function doc(elements, extra = {}) {
  const text = extra.text || [];
  return {
    title: extra.title || 'Page',
    querySelectorAll: (sel) => (sel.indexOf('button') >= 0 ? elements : text),
    __overlordRefs: null,
  };
}

test('assigns refs in document order', () => {
  const d = doc([el('button', { text: 'Go' }), el('a', { text: 'Home' })]);
  const snap = buildSnapshot(d);
  assert.match(snap.tree, /button "Go" \[ref_1\]/);
  assert.match(snap.tree, /a "Home" \[ref_2\]/);
});

test('stores the element map on the document', () => {
  const button = el('button', { text: 'Go' });
  const d = doc([button]);
  buildSnapshot(d);
  assert.strictEqual(d.__overlordRefs[0], button);
});

test('skips zero-size elements and does not consume a ref for them', () => {
  const hidden = el('button', { text: 'Hidden', rect: { left: 0, top: 0, width: 0, height: 0 } });
  const d = doc([hidden, el('button', { text: 'Visible' })]);
  const snap = buildSnapshot(d);
  assert.doesNotMatch(snap.tree, /Hidden/);
  assert.match(snap.tree, /button "Visible" \[ref_1\]/);
});

test('prefers aria-label over text content', () => {
  const d = doc([el('button', { text: 'X', attrs: { 'aria-label': 'Close dialog' } })]);
  assert.match(buildSnapshot(d).tree, /"Close dialog"/);
});

test('falls back to value for inputs with no text', () => {
  const d = doc([el('input', { value: 'kobi@example.com' })]);
  assert.match(buildSnapshot(d).tree, /"kobi@example.com"/);
});

test('collapses whitespace and truncates long labels', () => {
  const d = doc([el('button', { text: '  a\n\n   b  ' })]);
  assert.match(buildSnapshot(d).tree, /"a b"/);
  const long = doc([el('button', { text: 'z'.repeat(200) })]);
  assert.ok(buildSnapshot(long).tree.length < 140);
});

test('reports an empty tree rather than throwing on a page with nothing interactive', () => {
  const snap = buildSnapshot(doc([]));
  assert.strictEqual(snap.tree, '(no interactive elements)');
});

test('SNAPSHOT_SOURCE is self-contained — it closes over nothing', () => {
  assert.doesNotMatch(SNAPSHOT_SOURCE, /\brequire\b|\bmodule\b/);
  assert.match(SNAPSHOT_SOURCE, /\(document\)/);
});

test('refPointSource embeds the ref safely', () => {
  assert.match(refPointSource('ref_3'), /"ref_3"/);
  // A quote in the ref must come back escaped, so it cannot close the string
  // literal and run as code. The payload text still appears — escaped — so
  // assert on the escaping, not on its absence.
  assert.match(refPointSource('a"b'), /"a\\"b"/);
});

test('resolveRefPoint: valid ref returns element center from getBoundingClientRect', () => {
  const button = el('button', { text: 'Go', rect: { left: 10, top: 20, width: 100, height: 40 } });
  const d = doc([button]);
  buildSnapshot(d);
  const point = resolveRefPoint(d, 'ref_1');
  assert.deepStrictEqual(point, { x: 60, y: 40 });
});

test('resolveRefPoint: out-of-range ref index returns null', () => {
  const button = el('button', { text: 'Go' });
  const d = doc([button]);
  buildSnapshot(d);
  const point = resolveRefPoint(d, 'ref_999');
  assert.strictEqual(point, null);
});

test('resolveRefPoint: disconnected element returns null', () => {
  const button = el('button', { text: 'Go', isConnected: false });
  const d = doc([button]);
  buildSnapshot(d);
  const point = resolveRefPoint(d, 'ref_1');
  assert.strictEqual(point, null);
});

test('resolveRefPoint: unpopulated __overlordRefs returns null', () => {
  const d = doc([el('button', { text: 'Go' })]);
  // Do not call buildSnapshot — leave __overlordRefs unpopulated
  const point = resolveRefPoint(d, 'ref_1');
  assert.strictEqual(point, null);
});

test('resolveRefPoint: calls scrollIntoView on valid ref', () => {
  const button = el('button', { text: 'Go' });
  const d = doc([button]);
  buildSnapshot(d);
  resolveRefPoint(d, 'ref_1');
  assert.ok(button.__scrollIntoViewCalled(), 'scrollIntoView should be called');
});

// The spec's tool table promises "interactive elements + visible text" and calls
// browser_snapshot the primary perception tool. Without the text an agent can
// see a page's controls but cannot read a word of its content.
test('snapshot carries the page visible text, which is what an agent reads', () => {
  const d = doc([], { text: [el('h1', { text: 'Checkout' }), el('p', { text: 'Your order is confirmed.' })] });
  assert.strictEqual(buildSnapshot(d).text, 'Checkout\nYour order is confirmed.');
});

test('visible text is deduplicated so nested blocks are not repeated', () => {
  const d = doc([], { text: [el('p', { text: 'Same' }), el('li', { text: 'Same' }), el('h2', { text: 'Other' })] });
  assert.strictEqual(buildSnapshot(d).text, 'Same\nOther');
});

test('visible text collapses whitespace like the interactive labels do', () => {
  const d = doc([], { text: [el('p', { text: '  wrapped\n   line  ' })] });
  assert.strictEqual(buildSnapshot(d).text, 'wrapped line');
});

test('visible text is bounded — a snapshot must stay cheaper than a screenshot', () => {
  const many = [];
  for (let i = 0; i < 400; i++) many.push(el('p', { text: `paragraph ${i} ${'x'.repeat(300)}` }));
  const out = buildSnapshot(doc([], { text: many })).text;
  assert.ok(out.length > 0);
  assert.ok(out.length < 3000, `expected a bounded text block, got ${out.length} chars`);
});

test('a text node literally reading __proto__ cannot poison the dedupe map', () => {
  const d = doc([], { text: [el('p', { text: '__proto__' }), el('p', { text: 'after' })] });
  assert.strictEqual(buildSnapshot(d).text, '__proto__\nafter');
});

test('a page with no text-bearing elements yields an empty text block, not a throw', () => {
  assert.strictEqual(buildSnapshot(doc([])).text, '');
});

test('SNAPSHOT_SOURCE still closes over nothing now that it extracts text too', () => {
  assert.doesNotMatch(SNAPSHOT_SOURCE, /\brequire\b|\bmodule\b/);
  // Every constant it relies on has to travel inside its own source text.
  assert.match(SNAPSHOT_SOURCE, /h1,h2,h3/);
  assert.match(SNAPSHOT_SOURCE, /\(document\)/);
});
