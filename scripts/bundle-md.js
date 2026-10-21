// Bundles the markdown viewer's libraries (marked + highlight.js common languages + DOMPurify)
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
  const hljs = require('highlight.js/lib/common');
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
