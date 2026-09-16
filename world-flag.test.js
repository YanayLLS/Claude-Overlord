// The world is a feature flag: off means its scripts are never fetched and no world UI exists.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

test('world scripts are not loaded statically; the settings checkbox drives the flag', () => {
  const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
  assert.ok(!/<script[^>]*src="\.\/(world|three-bundle)\.js"/.test(html), 'world.js / three-bundle.js must load on demand');
  assert.match(html, /id="chk-world" onchange="setWorldEnabled\(this\.checked\)"/);
  assert.match(html, /function loadWorld\(\)[\s\S]*three-bundle\.js[\s\S]*world\.js/);
  const css = fs.readFileSync(__dirname + '/world.css', 'utf8');
  assert.match(css, /body:not\(\.world-on\) #hdr-world/);
});
