const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');

// Bundle xterm.js + fit addon into a single IIFE
const entry = path.join(root, 'scripts', '_xterm-entry.js');
fs.writeFileSync(entry, `
  const { Terminal } = require('@xterm/xterm');
  const { FitAddon } = require('@xterm/addon-fit');
  window.XTerminal = Terminal;
  window.XFitAddon = FitAddon;
`);
require('esbuild').buildSync({
  entryPoints: [entry], bundle: true, outfile: path.join(root, 'xterm-bundle.js'),
  format: 'iife', platform: 'browser', target: 'chrome120', minify: true,
});
fs.unlinkSync(entry);

// Copy xterm CSS
const css = path.join(root, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css');
if (fs.existsSync(css)) fs.copyFileSync(css, path.join(root, 'xterm.css'));

console.log('[bundle-xterm] Done');
