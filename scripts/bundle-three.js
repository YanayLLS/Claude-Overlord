// Bundle three.js into one local IIFE so the renderer never loads from a CDN.
// Mirrors scripts/bundle-xterm.js: skipped when the output already exists.
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const outJs = path.join(root, 'three-bundle.js');

if (fs.existsSync(outJs)) {
  console.log('[bundle-three] Already built — skipping');
  process.exit(0);
}

const entry = path.join(root, 'scripts', '_three-entry.js');
fs.writeFileSync(entry, `
  const THREE = require('three');
  window.THREE = THREE;
`);
require('esbuild').buildSync({
  entryPoints: [entry], bundle: true, outfile: outJs,
  format: 'iife', platform: 'browser', target: 'chrome120', minify: true,
});
fs.unlinkSync(entry);
console.log('[bundle-three] Done');
