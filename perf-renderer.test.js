// Renderer perf guards: things that were measured to cost paint/CPU while nobody was looking,
// and must not quietly come back. Static checks on the shipped files.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const read = f => fs.readFileSync(__dirname + '/' + f, 'utf8');

test('md-bundle.js and world.css load on demand, not with the page', () => {
  const html = read('index.html');
  assert.ok(!/<script[^>]*src="\.\/md-bundle\.js"/.test(html), 'md-bundle.js is 223 KB; docs-ui loads it with the first document');
  // world.css must stay eager: it also carries the "world off" rules for shared markup (#term-order & co.)
  assert.ok(/<link[^>]*href="\.\/world\.css"/.test(html), 'world.css is linked in the head');
  assert.match(read('docs-ui.js'), /function loadMd\(\)[\s\S]*md-bundle\.js/);

});

test('no :has() on the PR foot or dropdown, no backdrop-filter, no animated box-shadow', () => {
  const css = read('theme.css'), html = read('index.html');
  assert.ok(!/#list-foot:has\(/.test(css), 'renderPrBadge sets .pr-red/.pr-green on #list-foot instead');
  assert.ok(!/body:has\(#pr-dropdown/.test(css), 'a MutationObserver toggles body.pr-open instead');
  // modal overlays may blur (they're up briefly); these two sit over the terminal all session
  const rule = (src, sel) => { const i = src.indexOf(sel); return src.slice(i, src.indexOf('}', i)); };
  assert.ok(!/backdrop-filter:\s*blur/.test(rule(css, '#term-scroll-nav button {')), '#term-scroll-nav: solid rgba, no backdrop-filter');
  assert.ok(!/backdrop-filter:\s*blur/.test(rule(html, '#term-dead {')), '#term-dead: solid rgba, no backdrop-filter');
  for (const kf of ['upd-ring', 'upd-ping', 'needs-answer-flash']) {
    const m = new RegExp('@keyframes ' + kf + ' \\{([^}]*\\}[^}]*)\\}').exec(html);
    assert.ok(m && !/box-shadow|border-color/.test(m[1]), kf + ' must animate opacity only (compositor), not box-shadow');
  }
  for (const kf of ['pr-foot-glow', 'pr-chip-glow']) {
    const m = new RegExp('@keyframes ' + kf + ' \\{([^}]*\\}[^}]*)\\}').exec(css);
    assert.ok(m && !/box-shadow/.test(m[1]), kf + ' must animate opacity only');
  }
});

test('background pause exists and nothing relies on animationend for logic', () => {
  const html = read('index.html');
  assert.match(html, /body\.bg \*, body\.bg \*::before, body\.bg \*::after \{ animation-play-state:paused !important; \}/);
  assert.match(html, /function onBgChange\(\)/);
  // done-flash only removes its own class on animationend; anything else would stall while paused
  const script = html.slice(html.indexOf('<script>'));
  const ends = [...script.matchAll(/animationend/g)].length;
  assert.strictEqual(ends, 1, 'a new animationend listener must survive body.bg pausing its animation');
});
