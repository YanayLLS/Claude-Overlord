const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');

const outJs = path.join(root, 'xterm-bundle.js');
const outCss = path.join(root, 'xterm.css');

// Skip if bundle already exists
if (fs.existsSync(outJs) && fs.existsSync(outCss)) {
  console.log('[bundle-xterm] Already built — skipping');
  process.exit(0);
}

// Bundle xterm.js + fit addon into a single IIFE
const entry = path.join(root, 'scripts', '_xterm-entry.js');
fs.writeFileSync(entry, `
  const { Terminal } = require('@xterm/xterm');
  const { FitAddon } = require('@xterm/addon-fit');
  const { SearchAddon } = require('@xterm/addon-search');
  const { WebLinksAddon } = require('@xterm/addon-web-links');
  window.XTerminal = Terminal;
  window.XFitAddon = FitAddon;
  window.XSearchAddon = SearchAddon;
  window.XWebLinksAddon = WebLinksAddon;
`);
require('esbuild').buildSync({
  entryPoints: [entry], bundle: true, outfile: outJs,
  format: 'iife', platform: 'browser', target: 'chrome120', minify: true,
});
fs.unlinkSync(entry);

// Copy xterm CSS
const css = path.join(root, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css');
if (fs.existsSync(css)) fs.copyFileSync(css, outCss);

console.log('[bundle-xterm] Done');
