// Bundles the markdown viewer's libraries (marked + highlight.js core with a trimmed language set + DOMPurify)
// into md-bundle.js, one IIFE the page loads with a plain <script>, like xterm-bundle.js.
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const outJs = path.join(root, 'md-bundle.js');

if (fs.existsSync(outJs)) {
  console.log('[bundle-md] Already built — skipping');
  process.exit(0);
}

const entry = path.join(root, 'scripts', '_md-entry.js');
fs.writeFileSync(entry, `
  const { marked } = require('marked');
  // Core + the languages that show up in a plan/README (lib/common was ~40 incl. PHP, Ruby, Kotlin, Swift…: 157 KB).
  const hljs = require('highlight.js/lib/core');
  for (const [name, mod] of Object.entries({
    javascript: require('highlight.js/lib/languages/javascript'), typescript: require('highlight.js/lib/languages/typescript'),
    json: require('highlight.js/lib/languages/json'), bash: require('highlight.js/lib/languages/bash'), shell: require('highlight.js/lib/languages/shell'),
    powershell: require('highlight.js/lib/languages/powershell'), dos: require('highlight.js/lib/languages/dos'),
    python: require('highlight.js/lib/languages/python'), xml: require('highlight.js/lib/languages/xml'), css: require('highlight.js/lib/languages/css'),
    markdown: require('highlight.js/lib/languages/markdown'), diff: require('highlight.js/lib/languages/diff'), yaml: require('highlight.js/lib/languages/yaml'),
    sql: require('highlight.js/lib/languages/sql'), ini: require('highlight.js/lib/languages/ini'), plaintext: require('highlight.js/lib/languages/plaintext'),
    go: require('highlight.js/lib/languages/go'), rust: require('highlight.js/lib/languages/rust'), java: require('highlight.js/lib/languages/java'),
    csharp: require('highlight.js/lib/languages/csharp'), c: require('highlight.js/lib/languages/c'), cpp: require('highlight.js/lib/languages/cpp'),
  })) hljs.registerLanguage(name, mod);
  const DOMPurify = require('dompurify');
  window.marked = marked;
  window.hljs = hljs;
  window.DOMPurify = DOMPurify;
`);
require('esbuild').buildSync({
  entryPoints: [entry], bundle: true, outfile: outJs,
  format: 'iife', platform: 'browser', target: 'chrome120', minify: true,
});
fs.unlinkSync(entry);
console.log('[bundle-md] Done');
