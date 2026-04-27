# NSIS Installer + Auto-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the portable `.exe` target with a branded NSIS installer that auto-updates from GitHub Releases, and eliminate the Visual Studio build tools requirement by switching to prebuilt node-pty binaries.

**Architecture:** Switch `node-pty` → `node-pty-prebuilt-multiarch` (precompiled binaries, no C++ compiler needed). Add `electron-updater` which checks GitHub Releases on startup and prompts users to install updates. Build and publish releases via GitHub Actions on version tag push.

**Tech Stack:** electron-builder (NSIS), electron-updater, node-pty-prebuilt-multiarch, GitHub Actions, Node.js canvas-less BMP asset generation.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `package.json` | Modify | Swap node-pty, add electron-updater, NSIS target, GitHub publish config |
| `main.js` | Modify | Import and wire up electron-updater |
| `scripts/check-prerequisites.js` | Modify | Remove Windows C++ build tools check (no longer needed) |
| `scripts/create-installer-assets.js` | Create | Generate installer sidebar/header BMP images |
| `assets/icon.ico` | Create | App icon (Windows .ico format, multi-resolution) |
| `assets/installer-sidebar.bmp` | Create | NSIS sidebar graphic (164×314 px) |
| `assets/installer-header.bmp` | Create | NSIS header graphic (150×57 px) |
| `.github/workflows/release.yml` | Create | Build and publish on `v*` tag push |
| `start.bat` | Modify | Remove prerequisite check (no longer blocks install) |

---

## Task 1: Switch node-pty to prebuilt multiarch

**Files:**
- Modify: `package.json`
- Modify: `main.js` (line 9)
- Modify: `scripts/check-prerequisites.js`

> **Note:** No automated test possible here — native module loading is the test. Verify by running the app.

- [ ] **Step 1: Uninstall node-pty and install prebuilt variant**

```bash
npm uninstall node-pty
npm install node-pty-prebuilt-multiarch
```

Expected: `node_modules/node-pty-prebuilt-multiarch` exists, no compiler invoked.

- [ ] **Step 2: Update the require in main.js**

Find line 9 in `main.js`:
```js
const pty = require('node-pty');
```
Change to:
```js
const pty = require('node-pty-prebuilt-multiarch');
```

- [ ] **Step 3: Simplify check-prerequisites.js — remove Windows C++ check**

Replace the entire Windows block (lines 32–87) with:

```js
if (os.platform() === 'win32') {
  if (!hasPython()) {
    console.log('\nnode-pty requires Python 3 for some build scenarios.');
    const hasWinget = !!run('where winget');
    if (hasWinget) {
      console.log('Installing Python 3 via winget...');
      install('Python 3', 'winget install Python.Python.3.12 --accept-package-agreements --accept-source-agreements');
    } else {
      console.error('Install Python 3 from https://www.python.org/downloads/');
      console.error('Check "Add python.exe to PATH" during install.');
    }
  }
  process.exit(0);
}
```

- [ ] **Step 4: Verify app still launches**

```bash
npm start
```

Expected: App window opens, terminals work normally.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json main.js scripts/check-prerequisites.js
git commit -m "chore: switch node-pty to prebuilt-multiarch, drop VS build tools requirement"
```

---

## Task 2: Create installer assets

**Files:**
- Create: `scripts/create-installer-assets.js`
- Create: `assets/icon.ico` (generated)
- Create: `assets/installer-sidebar.bmp` (generated)
- Create: `assets/installer-header.bmp` (generated)

> **Note:** These assets are purely visual — no automated tests. Review output images manually.

- [ ] **Step 1: Create the asset generator script**

Create `scripts/create-installer-assets.js`:

```js
#!/usr/bin/env node
// Generates BMP installer graphics and a minimal ICO icon for Overlord.
// Colors: dark background #0d1117, accent purple #7c3aed, white text.
// Run: node scripts/create-installer-assets.js
const fs = require('fs');
const path = require('path');

const ASSETS = path.join(__dirname, '..', 'assets');
fs.mkdirSync(ASSETS, { recursive: true });

// ── BMP writer ────────────────────────────────────────────────────────────────
function writeBmp(filePath, width, height, pixels) {
  // pixels: Uint8Array of BGRA values, bottom-up row order
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelDataSize = rowSize * height;
  const fileSize = 54 + pixelDataSize;
  const buf = Buffer.alloc(fileSize, 0);

  // File header
  buf.write('BM', 0);
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(54, 10); // pixel data offset

  // DIB header (BITMAPINFOHEADER)
  buf.writeUInt32LE(40, 14);           // header size
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(-height, 22);       // negative = top-down
  buf.writeUInt16LE(1, 26);            // color planes
  buf.writeUInt16LE(24, 28);           // bits per pixel
  buf.writeUInt32LE(0, 30);            // no compression
  buf.writeUInt32LE(pixelDataSize, 34);

  // Pixel data
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = 54 + y * rowSize + x * 3;
      buf[dst] = pixels[src + 2];     // B
      buf[dst + 1] = pixels[src + 1]; // G
      buf[dst + 2] = pixels[src];     // R
    }
  }
  fs.writeFileSync(filePath, buf);
  console.log(`  Created: ${path.relative(process.cwd(), filePath)}`);
}

function hex(h) {
  const n = parseInt(h.replace('#', ''), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function fillRect(pixels, w, x0, y0, x1, y1, color) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      [pixels[i], pixels[i+1], pixels[i+2], pixels[i+3]] = [...color, 255];
    }
  }
}

function drawHorizontalGradient(pixels, w, x0, y0, x1, y1, colorA, colorB) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const t = (x - x0) / Math.max(1, x1 - x0 - 1);
      const i = (y * w + x) * 4;
      pixels[i]   = Math.round(colorA[0] + t * (colorB[0] - colorA[0]));
      pixels[i+1] = Math.round(colorA[1] + t * (colorB[1] - colorA[1]));
      pixels[i+2] = Math.round(colorA[2] + t * (colorB[2] - colorA[2]));
      pixels[i+3] = 255;
    }
  }
}

function drawCircle(pixels, w, cx, cy, r, color) {
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || y < 0) continue;
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) {
        const i = (y * w + x) * 4;
        [pixels[i], pixels[i+1], pixels[i+2], pixels[i+3]] = [...color, 255];
      }
    }
  }
}

// ── Sidebar: 164×314 ──────────────────────────────────────────────────────────
{
  const W = 164, H = 314;
  const px = new Uint8Array(W * H * 4);

  const bg    = hex('#0d1117');
  const dark  = hex('#161b22');
  const purp  = hex('#7c3aed');
  const purpL = hex('#a855f7');
  const white = hex('#ffffff');
  const gray  = hex('#8b949e');

  fillRect(px, W, 0, 0, W, H, bg);
  drawHorizontalGradient(px, W, 0, 0, W, H, dark, bg);

  // Accent bar on left edge
  fillRect(px, W, 0, 0, 3, H, purp);

  // Decorative circles (top area)
  drawCircle(px, W, 82, 80, 38, purp);
  drawCircle(px, W, 82, 80, 30, dark);
  drawCircle(px, W, 82, 80, 18, purpL);
  drawCircle(px, W, 82, 80, 8, white);

  // Horizontal rule
  fillRect(px, W, 20, 136, W - 20, 138, purp);

  // Bottom tag dots (decorative)
  for (let i = 0; i < 5; i++) {
    drawCircle(px, W, 20 + i * 12, H - 30, 3, i === 0 ? purp : gray);
  }

  writeBmp(path.join(ASSETS, 'installer-sidebar.bmp'), W, H, px);
}

// ── Header: 150×57 ────────────────────────────────────────────────────────────
{
  const W = 150, H = 57;
  const px = new Uint8Array(W * H * 4);

  const bg   = hex('#0d1117');
  const purp = hex('#7c3aed');
  const purpL= hex('#a855f7');
  const white= hex('#ffffff');

  fillRect(px, W, 0, 0, W, H, bg);

  // Bottom gradient strip
  drawHorizontalGradient(px, W, 0, H - 8, W, H, purp, bg);

  // Small icon circle
  drawCircle(px, W, 20, 28, 14, purp);
  drawCircle(px, W, 20, 28, 8, purpL);
  drawCircle(px, W, 20, 28, 3, white);

  writeBmp(path.join(ASSETS, 'installer-header.bmp'), W, H, px);
}

// ── Icon: minimal 16×16 and 32×32 ICO ────────────────────────────────────────
{
  function makeIconImage(size) {
    const px = new Uint8Array(size * size * 4);
    const purp = hex('#7c3aed');
    const purpL= hex('#a855f7');
    const white= hex('#ffffff');
    const bg   = hex('#0d1117');
    const half = size / 2;
    fillRect(px, size, 0, 0, size, size, bg);
    drawCircle(px, size, half, half, half - 1, purp);
    drawCircle(px, size, half, half, Math.round(half * 0.6), purpL);
    drawCircle(px, size, half, half, Math.round(half * 0.25), white);
    return px;
  }

  function icoEntry(size, pixels) {
    const rowSize = Math.ceil((size * 4) / 4) * 4;
    const pixelDataSize = rowSize * size;
    const bmpHeaderSize = 40;
    const totalSize = bmpHeaderSize + pixelDataSize;
    const buf = Buffer.alloc(totalSize, 0);

    buf.writeUInt32LE(40, 0);
    buf.writeInt32LE(size, 4);
    buf.writeInt32LE(size * 2, 8); // height * 2 for ICO XOR+AND masks
    buf.writeUInt16LE(1, 12);
    buf.writeUInt16LE(32, 14);
    buf.writeUInt32LE(3, 16); // BI_BITFIELDS
    buf.writeUInt32LE(pixelDataSize, 20);

    // Write BGRA pixels bottom-up
    for (let y = size - 1; y >= 0; y--) {
      for (let x = 0; x < size; x++) {
        const src = (y * size + x) * 4;
        const dst = bmpHeaderSize + ((size - 1 - y) * rowSize + x) * 4;
        buf[dst]   = pixels[src + 2]; // B
        buf[dst+1] = pixels[src + 1]; // G
        buf[dst+2] = pixels[src];     // R
        buf[dst+3] = pixels[src + 3]; // A
      }
    }
    return buf;
  }

  const sizes = [16, 32, 48, 256];
  const images = sizes.map(s => ({ size: s, data: icoEntry(s, makeIconImage(s)) }));

  const dirSize = 6 + sizes.length * 16;
  let offset = dirSize;
  const parts = [];

  // ICO file header
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: ICO
  header.writeUInt16LE(sizes.length, 4);
  parts.push(header);

  const dir = Buffer.alloc(sizes.length * 16);
  images.forEach(({ size, data }, i) => {
    const off = i * 16;
    dir[off]     = size === 256 ? 0 : size; // width (0 = 256)
    dir[off + 1] = size === 256 ? 0 : size; // height
    dir[off + 2] = 0;                        // color count
    dir[off + 3] = 0;                        // reserved
    dir.writeUInt16LE(1, off + 4);           // color planes
    dir.writeUInt16LE(32, off + 6);          // bpp
    dir.writeUInt32LE(data.length, off + 8); // size of image data
    dir.writeUInt32LE(offset, off + 12);     // offset
    offset += data.length;
  });
  parts.push(dir);
  images.forEach(({ data }) => parts.push(data));

  fs.writeFileSync(path.join(ASSETS, 'icon.ico'), Buffer.concat(parts));
  console.log(`  Created: assets/icon.ico`);
}

console.log('\nDone. Review assets/ folder.');
```

- [ ] **Step 2: Run the script to generate assets**

```bash
node scripts/create-installer-assets.js
```

Expected output:
```
  Created: assets/installer-sidebar.bmp
  Created: assets/installer-header.bmp
  Created: assets/icon.ico

Done. Review assets/ folder.
```

Verify `assets/` folder contains the three files.

- [ ] **Step 3: Commit**

```bash
git add scripts/create-installer-assets.js assets/
git commit -m "feat: add installer brand assets (icon, sidebar, header)"
```

---

## Task 3: Configure NSIS target and GitHub publish in package.json

**Files:**
- Modify: `package.json`

> **Note:** Config correctness is verified by the `npm run dist` build in Task 5.

- [ ] **Step 1: Replace the `build` section in package.json**

Open `package.json`. Replace the entire `"build"` object with:

```json
"build": {
  "appId": "com.overlord.claude",
  "productName": "Overlord",
  "icon": "assets/icon.ico",
  "publish": [
    {
      "provider": "github",
      "owner": "yanayLLS",
      "repo": "overlord"
    }
  ],
  "win": {
    "target": "nsis",
    "icon": "assets/icon.ico"
  },
  "nsis": {
    "oneClick": false,
    "allowToChangeInstallationDirectory": false,
    "installerIcon": "assets/icon.ico",
    "uninstallerIcon": "assets/icon.ico",
    "installerSidebar": "assets/installer-sidebar.bmp",
    "installerHeaderImage": "assets/installer-header.bmp",
    "welcomeTitle": "Overlord — Claude Agent Manager",
    "license": null,
    "runAfterFinish": true,
    "createDesktopShortcut": true,
    "createStartMenuShortcut": true,
    "shortcutName": "Overlord"
  },
  "files": [
    "main.js",
    "preload.js",
    "index.html",
    "xterm-bundle.js",
    "xterm.css",
    "qr.js",
    "mobile.html"
  ],
  "directories": {
    "output": "out"
  },
  "asar": true,
  "npmRebuild": false
}
```

- [ ] **Step 2: Add electron-updater to dependencies**

```bash
npm install electron-updater
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: configure NSIS target, GitHub publish, and electron-updater dep"
```

---

## Task 4: Wire up auto-updater in main.js

**Files:**
- Modify: `main.js` (top of file, and inside `app.whenReady` / window creation)

> **Note:** Auto-update can only be fully tested against a real GitHub release. The code path is verified by inspecting logs when the app starts.

- [ ] **Step 1: Add electron-updater import at top of main.js**

After line 8 (`const { spawn, exec, execSync } = require('child_process');`), add:

```js
const { autoUpdater } = require('electron-updater');
```

- [ ] **Step 2: Add updater configuration after the imports block**

After the constants block (after line ~33, near `const SERVER_URL_RE = ...`), add:

```js
// ── Auto-updater ──────────────────────────────────────────
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('update-available', info => {
  logToRenderer(`Update available: v${info.version}`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-available', { version: info.version });
  }
});

autoUpdater.on('update-downloaded', info => {
  logToRenderer(`Update downloaded: v${info.version} — will install on quit`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-downloaded', { version: info.version });
  }
});

autoUpdater.on('error', err => {
  logToRenderer(`Auto-updater error: ${err.message}`);
});
```

- [ ] **Step 3: Trigger update check after window is ready**

Find the `app.whenReady()` block in `main.js`. Locate where `mainWindow` is created and shown (look for `createWindow()` or `mainWindow = new BrowserWindow`). After the window `show` event or at the end of `app.whenReady()`, add:

```js
  // Check for updates (no-op in dev mode)
  if (app.isPackaged) {
    setTimeout(() => autoUpdater.checkForUpdatesAndNotify(), 3000);
  }
```

The `setTimeout` delay lets the window fully render before the check runs.

- [ ] **Step 4: Verify app still starts**

```bash
npm start
```

Expected: App launches normally. No errors in console about `electron-updater`. Since app is not packaged (`app.isPackaged` is false), no update check runs.

- [ ] **Step 5: Commit**

```bash
git add main.js
git commit -m "feat: wire up electron-updater for auto-update from GitHub releases"
```

---

## Task 5: Test local NSIS build

**Files:**
- No new files — verify build output

- [ ] **Step 1: Run dist build**

```bash
npm run dist
```

Expected: Build completes, `out/` folder contains `Overlord Setup <version>.exe`.

- [ ] **Step 2: Run the installer**

Double-click `out/Overlord Setup 1.0.0.exe`.

Expected:
- Installer opens with branded sidebar graphic on left (dark background, purple circle motif)
- Branded header graphic in top-right
- Installs to `C:\Users\<you>\AppData\Local\Programs\Overlord` (no admin prompt)
- App launches after install
- App works normally (agents, terminals, etc.)

- [ ] **Step 3: Verify uninstall works**

Open Windows Settings → Apps → find Overlord → Uninstall.

Expected: Clean uninstall, no leftover files in install dir.

- [ ] **Step 4: Commit if any package.json/asset tweaks were needed**

```bash
git add -p
git commit -m "fix: adjust installer config after local test"
```

---

## Task 6: GitHub Actions release workflow

**Files:**
- Create: `.github/workflows/release.yml`

> **Note:** Verified by pushing a version tag and observing the Actions run.

- [ ] **Step 1: Create the workflow file**

Create `.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: write

jobs:
  release-windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Build and publish
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: npm run dist -- --publish always
```

- [ ] **Step 2: Add GH_TOKEN note in README or package.json description**

The workflow uses `secrets.GITHUB_TOKEN` which GitHub provides automatically — no manual secret setup needed for public repos. For private repos, `GITHUB_TOKEN` still works if `permissions: contents: write` is set (already included above).

- [ ] **Step 3: Commit**

```bash
git add .github/
git commit -m "ci: add GitHub Actions release workflow — builds NSIS installer on version tag"
```

---

## Task 7: Simplify start.bat

**Files:**
- Modify: `start.bat`

The `preinstall` script still runs `check-prerequisites.js`, which now only checks Python on Windows (not C++ tools). `start.bat` can drop its explicit prerequisite check since `npm install` handles it via `preinstall`.

- [ ] **Step 1: Simplify start.bat**

Replace the entire contents of `start.bat` with:

```bat
@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo Download it from https://nodejs.org/
    pause
    exit /b 1
)

if not exist "node_modules\" (
    echo Installing dependencies...
    call npm install
    if !errorlevel! neq 0 (
        echo.
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
)

echo Starting Overlord...
call npm start
if %errorlevel% neq 0 (
    echo [ERROR] App failed to start.
    pause
    exit /b 1
)
```

- [ ] **Step 2: Verify start.bat still works**

Double-click `start.bat` (or run from terminal). Expected: app launches without prompting for VS tools.

- [ ] **Step 3: Commit**

```bash
git add start.bat
git commit -m "chore: simplify start.bat — drop C++ prereq check, no longer needed"
```

---

## Task 8: Publish first release

- [ ] **Step 1: Bump version in package.json to 1.0.0 (or desired release version)**

In `package.json`, ensure `"version": "1.0.0"`.

- [ ] **Step 2: Tag and push**

```bash
git tag v1.0.0
git push origin master --tags
```

Expected: GitHub Actions starts the `Release` workflow. Watch it at `github.com/yanayLLS/overlord/actions`.

- [ ] **Step 3: Verify release artifacts**

When workflow completes, check `github.com/yanayLLS/overlord/releases`. Should contain:
- `Overlord Setup 1.0.0.exe` — the NSIS installer
- `latest.yml` — metadata file electron-updater uses to detect new versions

- [ ] **Step 4: Test auto-update end-to-end**

1. Install `v1.0.0` via the released installer.
2. Bump `package.json` version to `1.0.1`, commit, tag `v1.0.1`, push.
3. Wait for CI to publish `v1.0.1` release.
4. Open the installed `v1.0.0` app — within ~3 seconds it should detect the update, download it silently, and notify on quit.

---

## Self-Review

**Spec coverage:**
- ✅ No VS build tools on install → Task 1 (node-pty-prebuilt-multiarch)
- ✅ NSIS installer → Task 3 (build config)
- ✅ Installer looks amazing → Task 2 (branded BMP assets + icon)
- ✅ Auto-update from GitHub Releases → Tasks 3 + 4 (publish config + electron-updater)
- ✅ Automated release publishing → Task 6 (GitHub Actions)
- ✅ start.bat simplified → Task 7

**Placeholder scan:** All steps contain actual code. No TBD items.

**Type consistency:** `autoUpdater` imported and used consistently. Asset paths match between `create-installer-assets.js` output and `package.json` `build` config.
