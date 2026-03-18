const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WEBVIEW_UI = path.resolve(ROOT, '..', 'webview-ui');
const WEBVIEW_DIST = path.resolve(ROOT, '..', 'dist', 'webview');
const TARGET = path.join(ROOT, 'webview');

console.log('[setup] Building webview-ui...');
execSync('npm run build', { cwd: WEBVIEW_UI, stdio: 'inherit' });

console.log('[setup] Copying webview build...');
if (fs.existsSync(TARGET)) fs.rmSync(TARGET, { recursive: true, force: true });
copyDir(WEBVIEW_DIST, TARGET);

// Copy fonts
const srcFonts = path.join(WEBVIEW_UI, 'public', 'fonts');
const dstFonts = path.join(TARGET, 'fonts');
if (fs.existsSync(srcFonts) && !fs.existsSync(dstFonts)) copyDir(srcFonts, dstFonts);

console.log('[setup] Generating index.html...');
const html = fs.readFileSync(path.join(TARGET, 'index.html'), 'utf-8');
const jsMatch = html.match(/src="([^"]+\.js)"/);
const cssMatch = html.match(/href="([^"]+\.css)"/);
const jsPath = `./webview/${(jsMatch ? jsMatch[1] : 'assets/index.js').replace(/^\.\//, '')}`;
const cssPath = `./webview/${(cssMatch ? cssMatch[1] : 'assets/index.css').replace(/^\.\//, '')}`;

fs.writeFileSync(path.join(ROOT, 'index.html'), `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Overlord</title>
  <style>
    @font-face {
      font-family: 'FS Pixel Sans';
      font-style: normal;
      font-weight: 400;
      font-display: swap;
      src: url('./webview/fonts/FSPixelSansUnicode-Regular.ttf') format('truetype');
    }
  </style>
  <link rel="stylesheet" href="${cssPath}" />
</head>
<body>
  <div id="root"></div>
  <script>
    if (window.overlordAPI) {
      window.overlordAPI.onExtensionMessage(function(data) {
        window.dispatchEvent(new MessageEvent('message', { data: data }));
      });
    }
  </script>
  <script type="module" crossorigin src="${jsPath}"></script>
</body>
</html>`);

console.log('[setup] Done!');

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    e.isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d);
  }
}
