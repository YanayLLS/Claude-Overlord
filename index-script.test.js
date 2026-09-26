// Run: node index-script.test.js
// index.html's inline <script> is one big scope: a duplicate top-level name or a typo
// is a SyntaxError that blanks the whole UI, and no other test loads it.
const assert = require('assert');
const html = require('fs').readFileSync(require('path').join(__dirname, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
assert.ok(scripts.length, 'no inline script found');
for (const s of scripts) new Function(s); // throws on a parse error
console.log('ok — index.html script parses');
