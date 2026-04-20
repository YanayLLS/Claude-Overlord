# QR Remote Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users scan a QR code from Overlord's header to open a mobile web UI that lists all agents, shows terminal output, and allows full interaction (send messages, create/close/restart agents).

**Architecture:** An HTTP + WebSocket server runs inside the Electron main process on a LAN-accessible port. The server serves a self-contained mobile HTML page and bridges WebSocket messages to/from the existing IPC command handler. A minimal QR code encoder (no npm deps) renders the URL as SVG in an overlay. Per-agent terminal output is ring-buffered so the mobile client gets recent history on connect.

**Tech Stack:** Node.js `http` + `crypto` (already imported), raw WebSocket protocol (no library), inline QR encoder, self-contained mobile HTML page.

**Constraints:**
- Zero new npm dependencies
- No changes to existing agent control logic
- HTTP server fails gracefully if port unavailable
- `package.json` build files updated for new files
- Single mobile connection at a time

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `qr.js` | Minimal QR code encoder — `generateQR(text)` → 2D boolean matrix |
| Create | `mobile.html` | Self-contained mobile web app (HTML + CSS + JS inline) |
| Modify | `main.js:70-80` | Add `termBuffers` Map, `remoteWs` variable |
| Modify | `main.js:82-84` | Extend `send()` to also broadcast to WebSocket client |
| Modify | `main.js:909-910` | Hook `proc.onData` to also fill terminal buffer |
| Modify | `main.js:940-955` | Clean up terminal buffer on agent close |
| Modify | `main.js:1874-1915` | Start HTTP/WS server in `app.whenReady()` |
| Modify | `index.html:644` | Add QR overlay CSS |
| Modify | `index.html:786-793` | Add QR header button |
| Modify | `index.html:876-898` | Add QR overlay HTML |
| Modify | `index.html` (script) | Add QR SVG renderer + overlay toggle logic |
| Modify | `package.json:35-41` | Add `qr.js` and `mobile.html` to build files |

---

### Task 1: QR Code Encoder (`qr.js`)

Self-contained module. No dependencies. Exports `generateQR(text)` returning a 2D boolean matrix, and `generateQRSvg(text, moduleSize)` returning an SVG string.

**Files:**
- Create: `qr.js`

- [ ] **Step 1: Create `qr.js` with full QR encoder**

```javascript
// qr.js — Minimal QR code encoder (byte mode, ECC-L, versions 1-10)
// No dependencies. Used by Overlord to generate QR codes for remote access URL.

'use strict';

// ── Galois Field GF(2^8) arithmetic ──
const EXP = new Array(512);
const LOG = new Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x >= 256) x ^= 0x11d; // primitive polynomial
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

// ── Reed-Solomon ──
function rsGenPoly(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const ng = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      ng[j] ^= gfMul(g[j], EXP[i]);
      ng[j + 1] ^= g[j];
    }
    g = ng;
  }
  return g;
}

function rsEncode(data, eccLen) {
  const gen = rsGenPoly(eccLen);
  const msg = new Array(data.length + eccLen).fill(0);
  for (let i = 0; i < data.length; i++) msg[i] = data[i];
  for (let i = 0; i < data.length; i++) {
    const coef = msg[i];
    if (coef === 0) continue;
    for (let j = 0; j < gen.length; j++) {
      msg[i + j] ^= gfMul(gen[j], coef);
    }
  }
  return msg.slice(data.length);
}

// ── QR Version parameters (ECC level L only) ──
// [totalCodewords, eccCodewordsPerBlock, numBlocks, dataCodewords]
const VERSIONS = [
  null, // index 0 unused
  [26, 7, 1, 19],    // v1 21x21
  [44, 10, 1, 34],   // v2 25x25
  [70, 15, 1, 55],   // v3 29x29
  [100, 20, 1, 80],  // v4 33x33
  [134, 26, 1, 108], // v5 37x37
  [172, 18, 2, 136], // v6 41x41
  [196, 20, 2, 156], // v7 45x45
  [242, 24, 2, 194], // v8 49x49
  [292, 30, 2, 232], // v9 53x53
  [346, 18, 4, 274], // v10 57x57
];

// Alignment pattern center positions per version
const ALIGN_POS = [
  null, [], [6,18], [6,22], [6,26], [6,30], [6,34],
  [6,22,38], [6,24,42], [6,26,46], [6,28,50],
];

// Format info bits for ECC-L + mask 0-7 (pre-computed with BCH)
const FORMAT_BITS = [
  0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976,
];

function chooseVersion(dataLen) {
  // Byte mode overhead: 4 (mode) + 8 or 16 (count) bits + data*8 + 4 (terminator, max)
  for (let v = 1; v <= 10; v++) {
    const countBits = v <= 9 ? 8 : 16;
    const totalBits = 4 + countBits + dataLen * 8;
    const capacity = VERSIONS[v][3] * 8;
    if (totalBits <= capacity) return v;
  }
  throw new Error('Data too long for QR versions 1-10');
}

function encodeData(bytes, version) {
  const ver = VERSIONS[version];
  const countBits = version <= 9 ? 8 : 16;
  const bits = [];

  function pushBits(val, len) {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  }

  // Mode indicator: byte mode = 0100
  pushBits(4, 4);
  // Character count
  pushBits(bytes.length, countBits);
  // Data
  for (const b of bytes) pushBits(b, 8);
  // Terminator (up to 4 zeros)
  const dataBits = ver[3] * 8;
  const termLen = Math.min(4, dataBits - bits.length);
  for (let i = 0; i < termLen; i++) bits.push(0);
  // Pad to byte boundary
  while (bits.length % 8 !== 0) bits.push(0);
  // Pad bytes (0xEC, 0x11 alternating)
  const padBytes = [0xEC, 0x11];
  let pi = 0;
  while (bits.length < dataBits) {
    pushBits(padBytes[pi % 2], 8);
    pi++;
  }

  // Convert to byte array
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | (bits[i + j] || 0);
    codewords.push(b);
  }
  return codewords;
}

function addErrorCorrection(data, version) {
  const ver = VERSIONS[version];
  const eccPerBlock = ver[1];
  const numBlocks = ver[2];
  const dataPerBlock = Math.floor(data.length / numBlocks);
  const remainder = data.length % numBlocks;

  const blocks = [];
  const eccBlocks = [];
  let offset = 0;
  for (let b = 0; b < numBlocks; b++) {
    const blockLen = dataPerBlock + (b < remainder ? 1 : 0);
    const block = data.slice(offset, offset + blockLen);
    blocks.push(block);
    eccBlocks.push(rsEncode(block, eccPerBlock));
    offset += blockLen;
  }

  // Interleave data blocks
  const result = [];
  const maxDataLen = Math.max(...blocks.map(b => b.length));
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of blocks) {
      if (i < block.length) result.push(block[i]);
    }
  }
  // Interleave ECC blocks
  for (let i = 0; i < eccPerBlock; i++) {
    for (const ecc of eccBlocks) {
      if (i < ecc.length) result.push(ecc[i]);
    }
  }
  return result;
}

// ── Matrix construction ──
function createMatrix(version) {
  const size = version * 4 + 17;
  const matrix = Array.from({ length: size }, () => new Array(size).fill(-1)); // -1 = unset
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  function setModule(r, c, val, reserve) {
    if (r >= 0 && r < size && c >= 0 && c < size) {
      matrix[r][c] = val ? 1 : 0;
      if (reserve) reserved[r][c] = true;
    }
  }

  // Finder patterns (7x7 at corners)
  function placeFinder(row, col) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r, cc = col + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const inOuter = r === -1 || r === 7 || c === -1 || c === 7;
        const inBorder = r === 0 || r === 6 || c === 0 || c === 6;
        const inInner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        setModule(rr, cc, !inOuter && (inBorder || inInner), true);
      }
    }
  }

  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  // Alignment patterns
  if (version >= 2) {
    const pos = ALIGN_POS[version];
    for (const r of pos) {
      for (const c of pos) {
        // Skip if overlapping finder
        if (r <= 8 && c <= 8) continue;
        if (r <= 8 && c >= size - 8) continue;
        if (r >= size - 8 && c <= 8) continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const val = Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0);
            setModule(r + dr, c + dc, val, true);
          }
        }
      }
    }
  }

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    setModule(6, i, i % 2 === 0, true);
    setModule(i, 6, i % 2 === 0, true);
  }

  // Dark module
  setModule(size - 8, 8, 1, true);

  // Reserve format info areas
  for (let i = 0; i < 9; i++) {
    if (!reserved[8]?.[i]) setModule(8, i, 0, true);
    if (!reserved[i]?.[8]) setModule(i, 8, 0, true);
  }
  for (let i = 0; i < 8; i++) {
    setModule(8, size - 8 + i, 0, true);
    setModule(size - 7 + i, 8, 0, true);
  }

  return { matrix, reserved, size };
}

function placeData(matrix, reserved, size, data) {
  const bits = [];
  for (const byte of data) {
    for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);
  }
  // Add remainder bits for version (v1: 0, v2-6: 7, v7-10: 0... simplified)
  // Versions 2-6 need 7 remainder bits
  // Actually: v1=0, v2-v6=7, v7-v13=0, ... but we only handle up to 10
  // For simplicity, versions 2-6 get 7 remainder bits, 7-10 get 0
  // (The exact remainder bits are: v1:0, v2-6:7, v7-13:0 ... no wait)
  // Correct remainder bits: v1:0, v2:7, v3:7, v4:7, v5:7, v6:7, v7:0...
  // Actually let me just not add them — they're padding zeros at the end.

  let bitIdx = 0;
  // Traverse upward then downward in 2-column-wide stripes, right to left
  let upward = true;
  for (let col = size - 1; col >= 1; col -= 2) {
    if (col === 6) col = 5; // skip timing column
    const rows = upward
      ? Array.from({ length: size }, (_, i) => size - 1 - i)
      : Array.from({ length: size }, (_, i) => i);
    for (const row of rows) {
      for (const dc of [0, -1]) {
        const c = col + dc;
        if (c < 0 || c >= size) continue;
        if (reserved[row][c]) continue;
        matrix[row][c] = bitIdx < bits.length ? bits[bitIdx] : 0;
        bitIdx++;
      }
    }
    upward = !upward;
  }
}

// ── Masking ──
const MASK_FNS = [
  (r, c) => (r + c) % 2 === 0,
  (r, c) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2 + (r * c) % 3) === 0,
  (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
  (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0,
];

function applyMask(matrix, reserved, size, maskIdx) {
  const fn = MASK_FNS[maskIdx];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!reserved[r][c] && fn(r, c)) {
        matrix[r][c] ^= 1;
      }
    }
  }
}

function writeFormatInfo(matrix, size, maskIdx) {
  const bits = FORMAT_BITS[maskIdx];
  // Horizontal: modules around top-left finder
  const hPositions = [0,1,2,3,4,5,7,8, /*then*/ size-8,size-7,size-6,size-5,size-4,size-3,size-2,size-1];
  // Vertical: modules around top-left finder
  const vPositions = [size-1,size-2,size-3,size-4,size-5,size-6,size-7, size-8, /*then*/ 7,5,4,3,2,1,0];

  for (let i = 0; i < 15; i++) {
    const bit = (bits >> (14 - i)) & 1;
    // Horizontal strip along row 8
    if (i < 8) {
      matrix[8][hPositions[i]] = bit;
    } else {
      matrix[8][hPositions[i]] = bit;
    }
    // Vertical strip along column 8
    matrix[vPositions[i]][8] = bit;
  }
}

function penaltyScore(matrix, size) {
  let score = 0;
  // Rule 1: runs of 5+ same-colored modules in a row/column
  for (let r = 0; r < size; r++) {
    let run = 1;
    for (let c = 1; c < size; c++) {
      if (matrix[r][c] === matrix[r][c - 1]) { run++; }
      else { if (run >= 5) score += run - 2; run = 1; }
    }
    if (run >= 5) score += run - 2;
  }
  for (let c = 0; c < size; c++) {
    let run = 1;
    for (let r = 1; r < size; r++) {
      if (matrix[r][c] === matrix[r - 1][c]) { run++; }
      else { if (run >= 5) score += run - 2; run = 1; }
    }
    if (run >= 5) score += run - 2;
  }
  // Rule 2: 2x2 blocks of same color
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = matrix[r][c];
      if (v === matrix[r][c+1] && v === matrix[r+1][c] && v === matrix[r+1][c+1]) score += 3;
    }
  }
  return score;
}

// ── Public API ──
function generateQR(text) {
  const bytes = Array.from(Buffer.from(text, 'utf-8'));
  const version = chooseVersion(bytes.length);
  const data = encodeData(bytes, version);
  const withEcc = addErrorCorrection(data, version);
  const { matrix, reserved, size } = createMatrix(version);
  placeData(matrix, reserved, size, withEcc);

  // Try all 8 masks, pick lowest penalty
  let bestMask = 0, bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    const copy = matrix.map(r => [...r]);
    applyMask(copy, reserved, size, m);
    writeFormatInfo(copy, size, m);
    const s = penaltyScore(copy, size);
    if (s < bestScore) { bestScore = s; bestMask = m; }
  }

  applyMask(matrix, reserved, size, bestMask);
  writeFormatInfo(matrix, size, bestMask);

  return { matrix, size };
}

function generateQRSvg(text, moduleSize = 4) {
  const { matrix, size } = generateQR(text);
  const quiet = 4; // quiet zone modules
  const total = (size + quiet * 2) * moduleSize;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${total}" height="${total}">`;
  svg += `<rect width="${total}" height="${total}" fill="#fff"/>`;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r][c]) {
        const x = (c + quiet) * moduleSize;
        const y = (r + quiet) * moduleSize;
        svg += `<rect x="${x}" y="${y}" width="${moduleSize}" height="${moduleSize}" fill="#000"/>`;
      }
    }
  }
  svg += '</svg>';
  return svg;
}

module.exports = { generateQR, generateQRSvg };
```

- [ ] **Step 2: Verify module loads without error**

Run: `node -e "const q = require('./qr.js'); console.log(q.generateQRSvg('http://192.168.1.1:7778').slice(0,80))"`

Expected: SVG string starting with `<svg xmlns=`

- [ ] **Step 3: Commit**

```bash
git add qr.js
git commit -m "feat: add minimal QR code encoder (no dependencies)"
```

---

### Task 2: Terminal Output Buffering (`main.js`)

Buffer the last 50KB of terminal output per agent so the mobile client can get recent history on connect.

**Files:**
- Modify: `main.js:70-80` (add termBuffers Map)
- Modify: `main.js:909-910` (hook proc.onData)
- Modify: `main.js:940-955` (cleanup on close)

- [ ] **Step 1: Add `termBuffers` Map and constants**

After line 79 (`const pendingClearAgents = new Set();`), add:

```javascript
const termBuffers = new Map(); // agentId -> string (last TERM_BUFFER_MAX chars of terminal output)
const TERM_BUFFER_MAX = 50000;
```

- [ ] **Step 2: Hook into `proc.onData` to fill buffer**

In `createAgent()`, modify the `proc.onData` callback at line 909-910. Change:

```javascript
proc.onData((d) => {
  try { send({ type: 'termData', id, data: d }); scanForServers(id, d); extractSpinnerText(id, d); } catch {}
```

To:

```javascript
proc.onData((d) => {
  try { send({ type: 'termData', id, data: d }); scanForServers(id, d); extractSpinnerText(id, d); } catch {}
  // Buffer terminal output for mobile remote
  let buf = termBuffers.get(id) || '';
  buf += d;
  if (buf.length > TERM_BUFFER_MAX) buf = buf.slice(-TERM_BUFFER_MAX);
  termBuffers.set(id, buf);
```

- [ ] **Step 3: Clean up buffer on agent close**

In `closeAgent()`, after `inputBuffers.delete(id);` (line 950), add:

```javascript
termBuffers.delete(id);
```

- [ ] **Step 4: Commit**

```bash
git add main.js
git commit -m "feat: buffer terminal output per agent for remote access"
```

---

### Task 3: HTTP + WebSocket Server (`main.js`)

Add LAN IP detection, HTTP server serving `mobile.html`, and a raw WebSocket implementation that bridges to the existing IPC command handler.

**Files:**
- Modify: `main.js:70-80` (add remote state variables)
- Modify: `main.js:82-84` (extend `send()`)
- Modify: `main.js:1874-1915` (start server on app ready)
- Modify: `main.js` (new section after IPC handler, ~line 1848)

- [ ] **Step 1: Add remote state variables**

After the `termBuffers` lines added in Task 2, add:

```javascript
let remoteWs = null; // current WebSocket connection (only one at a time)
let remoteViewingAgent = null; // which agent the mobile client is viewing
const REMOTE_PORT = 7778;
```

- [ ] **Step 2: Add LAN IP detection function**

After `isSystemMessage` function (around line 270), add:

```javascript
function getLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}
```

- [ ] **Step 3: Add WebSocket frame encode/decode**

After the `getLanIp` function, add:

```javascript
// ── WebSocket protocol (minimal, text frames only) ──
function wsHandshake(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return null; }
  const accept = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-5AB5353BE70E')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  return socket;
}

function wsEncodeFrame(text) {
  const data = Buffer.from(text, 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    // Write as two 32-bit values for compatibility
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  return Buffer.concat([header, data]);
}

function wsDecodeFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let payloadLen = buffer[1] & 0x7f;
  let offset = 2;
  if (payloadLen === 126) {
    if (buffer.length < 4) return null;
    payloadLen = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buffer.length < 10) return null;
    payloadLen = Number(buffer.readUInt32BE(6)); // ignore high 32 bits
    offset = 10;
  }
  const maskLen = masked ? 4 : 0;
  const totalLen = offset + maskLen + payloadLen;
  if (buffer.length < totalLen) return null;
  let payload;
  if (masked) {
    const mask = buffer.slice(offset, offset + 4);
    payload = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i++) {
      payload[i] = buffer[offset + 4 + i] ^ mask[i % 4];
    }
  } else {
    payload = buffer.slice(offset, offset + payloadLen);
  }
  return { opcode, data: payload.toString('utf8'), totalLen };
}

function wsSend(socket, data) {
  if (!socket || socket.destroyed) return;
  try { socket.write(wsEncodeFrame(typeof data === 'string' ? data : JSON.stringify(data))); } catch {}
}
```

- [ ] **Step 4: Add `broadcastToRemote` and modify `send()`**

Change the existing `send()` function from:

```javascript
function send(data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('msg', data);
}
```

To:

```javascript
function send(data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('msg', data);
  // Forward to mobile WebSocket client (skip termData unless viewing that agent)
  if (remoteWs && !remoteWs.destroyed) {
    if (data.type === 'termData') {
      if (data.id === remoteViewingAgent) wsSend(remoteWs, data);
    } else {
      wsSend(remoteWs, data);
    }
  }
}
```

- [ ] **Step 5: Add remote command handler**

After the `broadcastToRemote` changes, add a function to handle commands from the mobile client. Place this near the IPC handler (after line 1848):

```javascript
// ── Remote (mobile) command handler ──
function handleRemoteCmd(msg) {
  switch (msg.type) {
    case 'viewAgent': {
      remoteViewingAgent = msg.id;
      // Send buffered terminal output
      const buf = termBuffers.get(msg.id);
      if (buf) wsSend(remoteWs, { type: 'termData', id: msg.id, data: buf });
      break;
    }
    case 'getState': {
      // Send full state snapshot to mobile client
      const agentList = [];
      for (const [id, a] of agents) {
        const st = a.isWaiting ? 'waiting' : (a.toolIds.size > 0 || a.hadTools ? 'active' : 'idle');
        agentList.push({
          id, cwd: a.cwd, title: a.title, customName: a.customName,
          agentName: a.agentName, status: st, lastPrompt: a.lastPrompt,
          preview: a.lastText, createdAt: a.createdAt,
          stats: a.stats, spinnerText: a.spinnerText,
        });
      }
      wsSend(remoteWs, { type: 'fullState', agents: agentList });
      break;
    }
    case 'createAgent': createAgent(msg.cwd, msg.prompt); break;
    case 'closeAgent': closeAgent(msg.id); break;
    case 'restartAgent': {
      const a = agents.get(msg.id);
      if (a) {
        const c = a.cwd;
        const savedTitle = a.title || '';
        const savedCustomName = a.customName;
        const savedAgentName = a.agentName;
        closeAgent(msg.id);
        const newId = createAgent(c);
        const na = agents.get(newId);
        if (na && savedAgentName) { na.agentName = savedAgentName; send({ type: 'agentNameChanged', id: newId, agentName: savedAgentName }); }
        if (savedTitle && na) { na.title = savedTitle; na.customName = savedCustomName; send({ type: 'title', id: newId, text: savedTitle, customName: savedCustomName }); saveState(); }
      }
      break;
    }
    case 'termInput': handleTermInput(msg.id, msg.data); break;
    case 'getProjects': {
      const projects = new Set();
      for (const [, a] of agents) if (a.cwd) projects.add(a.cwd);
      wsSend(remoteWs, { type: 'projects', projects: [...projects] });
      break;
    }
  }
}
```

- [ ] **Step 6: Add HTTP server creation and startup**

Add this section after the remote command handler:

```javascript
// ── Remote access HTTP/WebSocket server ──
let remoteServer = null;
let remoteUrl = null;

function startRemoteServer() {
  const mobileHtml = (() => {
    try { return fs.readFileSync(path.join(__dirname, 'mobile.html'), 'utf-8'); }
    catch { return '<html><body>mobile.html not found</body></html>'; }
  })();

  const { generateQRSvg } = require('./qr.js');

  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(mobileHtml);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  server.on('upgrade', (req, socket) => {
    if (req.url !== '/ws') { socket.destroy(); return; }
    // Kick previous connection
    if (remoteWs && !remoteWs.destroyed) {
      try { remoteWs.end(); } catch {}
      remoteWs = null;
    }
    const ws = wsHandshake(req, socket);
    if (!ws) return;
    remoteWs = ws;
    remoteViewingAgent = null;
    console.log('[Overlord] Mobile client connected');

    // Send initial state
    handleRemoteCmd({ type: 'getState' });

    let wsBuf = Buffer.alloc(0);
    ws.on('data', (chunk) => {
      wsBuf = Buffer.concat([wsBuf, chunk]);
      while (wsBuf.length >= 2) {
        const frame = wsDecodeFrame(wsBuf);
        if (!frame) break;
        wsBuf = wsBuf.slice(frame.totalLen);
        if (frame.opcode === 0x8) {
          // Close frame — respond and disconnect
          try { ws.end(wsEncodeFrame('')); } catch {}
          ws.destroy();
          if (remoteWs === ws) { remoteWs = null; remoteViewingAgent = null; }
          console.log('[Overlord] Mobile client disconnected');
          return;
        }
        if (frame.opcode === 0x9) {
          // Ping — respond with pong
          const pong = Buffer.alloc(2);
          pong[0] = 0x8a; // FIN + pong
          pong[1] = 0;
          try { ws.write(pong); } catch {}
          continue;
        }
        if (frame.opcode === 0x1) {
          // Text frame — parse as JSON command
          try {
            const msg = JSON.parse(frame.data);
            handleRemoteCmd(msg);
          } catch (e) {
            console.log('[Overlord] Bad remote message:', e.message);
          }
        }
      }
    });

    ws.on('close', () => {
      if (remoteWs === ws) { remoteWs = null; remoteViewingAgent = null; }
      console.log('[Overlord] Mobile client disconnected');
    });
    ws.on('error', () => {
      if (remoteWs === ws) { remoteWs = null; remoteViewingAgent = null; }
    });
  });

  const tryListen = (port) => {
    server.listen(port, '0.0.0.0', () => {
      const ip = getLanIp();
      remoteUrl = `http://${ip}:${port}`;
      remoteServer = server;
      const svg = generateQRSvg(remoteUrl, 4);
      send({ type: 'remoteReady', url: remoteUrl, qrSvg: svg });
      console.log(`[Overlord] Remote access: ${remoteUrl}`);
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && port < REMOTE_PORT + 10) {
        console.log(`[Overlord] Port ${port} in use, trying ${port + 1}`);
        tryListen(port + 1);
      } else {
        console.log(`[Overlord] Remote server failed: ${err.message}`);
      }
    });
  };
  tryListen(REMOTE_PORT);
}
```

- [ ] **Step 7: Start the server in `app.whenReady()`**

In the `app.whenReady().then(...)` block, after the `mainWindow.webContents.once('did-finish-load', ...)` callback (around line 1901), add:

```javascript
  // Start remote access server
  startRemoteServer();
```

- [ ] **Step 8: Clean up server on quit**

In the `app.on('before-quit', ...)` handler (line 1916), at the top of the callback, add:

```javascript
  if (remoteServer) { try { remoteServer.close(); } catch {} }
  if (remoteWs) { try { remoteWs.destroy(); } catch {} }
```

- [ ] **Step 9: Commit**

```bash
git add main.js
git commit -m "feat: add HTTP/WebSocket server for mobile remote access"
```

---

### Task 4: Mobile HTML Page (`mobile.html`)

Self-contained mobile web app served by the HTTP server. Dark theme matching Overlord. Agent list → tap → terminal view with input.

**Files:**
- Create: `mobile.html`

- [ ] **Step 1: Create `mobile.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#1e1e2e">
<title>Overlord Remote</title>
<style>
:root {
  --bg: #1e1e2e; --bg2: #262637; --bg3: #313244;
  --text: #cdd6f4; --dim: #6c7086; --accent: #89b4fa;
  --green: #a6e3a1; --red: #f38ba8; --yellow: #f9e2af;
  --purple: #cba6f7; --border: #45475a;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: var(--bg); color: var(--text);
  height: 100dvh; overflow: hidden;
  display: flex; flex-direction: column;
  -webkit-tap-highlight-color: transparent;
}
header {
  background: var(--bg2); padding: 12px 16px;
  display: flex; align-items: center; gap: 10px;
  border-bottom: 1px solid var(--border);
  min-height: 52px; flex-shrink: 0;
}
header h1 { font-size: 16px; font-weight: 600; flex: 1; }
header .back { display: none; font-size: 22px; cursor: pointer; color: var(--accent); padding: 0 8px 0 0; }
header .agent-name { display: none; font-size: 14px; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
header .status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.action-btn {
  background: none; border: 1px solid var(--border); color: var(--dim);
  border-radius: 6px; padding: 6px 10px; font-size: 12px; cursor: pointer;
}
.action-btn:active { background: var(--bg3); color: var(--text); }
.action-btn.danger { border-color: var(--red); color: var(--red); }

/* ── Agent list ── */
#agent-list {
  flex: 1; overflow-y: auto; padding: 8px;
  -webkit-overflow-scrolling: touch;
}
.agent-card {
  background: var(--bg2); border: 1px solid var(--border); border-radius: 10px;
  padding: 14px; margin-bottom: 8px; cursor: pointer;
  display: flex; flex-direction: column; gap: 6px;
  transition: background .15s;
}
.agent-card:active { background: var(--bg3); }
.agent-top { display: flex; align-items: center; gap: 8px; }
.agent-top .name { font-size: 14px; font-weight: 600; flex: 1; }
.agent-top .status {
  font-size: 10px; padding: 2px 8px; border-radius: 10px;
  text-transform: uppercase; font-weight: 600; letter-spacing: .5px;
}
.status-active { background: rgba(166,227,161,.15); color: var(--green); }
.status-waiting { background: rgba(249,226,175,.15); color: var(--yellow); }
.status-idle { background: rgba(108,112,134,.15); color: var(--dim); }
.agent-prompt { font-size: 12px; color: var(--dim); line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.agent-project { font-size: 10px; color: var(--dim); opacity: .7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

#new-agent-btn {
  display: block; width: 100%; padding: 14px; margin-top: 4px;
  background: none; border: 2px dashed var(--border); border-radius: 10px;
  color: var(--dim); font-size: 14px; cursor: pointer; text-align: center;
}
#new-agent-btn:active { background: var(--bg2); color: var(--text); border-color: var(--accent); }

/* ── Agent detail ── */
#agent-detail { display: none; flex-direction: column; flex: 1; overflow: hidden; }
#terminal-output {
  flex: 1; overflow-y: auto; padding: 10px 14px;
  font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
  font-size: 12px; line-height: 1.5; white-space: pre-wrap;
  word-break: break-word; background: #000; color: #cdd6f4;
  -webkit-overflow-scrolling: touch;
}
#input-bar {
  display: flex; gap: 8px; padding: 10px 12px;
  background: var(--bg2); border-top: 1px solid var(--border);
  flex-shrink: 0;
}
#input-bar textarea {
  flex: 1; background: var(--bg3); border: 1px solid var(--border);
  border-radius: 8px; color: var(--text); padding: 10px 12px;
  font-family: inherit; font-size: 14px; resize: none;
  min-height: 42px; max-height: 120px; line-height: 1.4;
}
#input-bar textarea::placeholder { color: var(--dim); }
#input-bar textarea:focus { outline: none; border-color: var(--accent); }
#send-btn {
  background: var(--accent); color: var(--bg); border: none;
  border-radius: 8px; padding: 0 18px; font-size: 14px;
  font-weight: 600; cursor: pointer; flex-shrink: 0;
}
#send-btn:active { opacity: .8; }

/* ── Connection status ── */
#conn-status {
  position: fixed; top: 56px; left: 50%; transform: translateX(-50%);
  background: var(--red); color: #fff; font-size: 11px;
  padding: 4px 14px; border-radius: 0 0 8px 8px;
  display: none; z-index: 100; font-weight: 600;
}

/* ── New agent modal ── */
#new-agent-modal {
  display: none; position: fixed; inset: 0; background: rgba(0,0,0,.6);
  z-index: 200; align-items: flex-end; justify-content: center;
}
#new-agent-modal.open { display: flex; }
.modal-sheet {
  background: var(--bg2); border-radius: 16px 16px 0 0;
  width: 100%; max-width: 500px; padding: 20px 16px 32px;
}
.modal-sheet h3 { font-size: 16px; margin-bottom: 12px; }
.modal-sheet select, .modal-sheet textarea {
  width: 100%; background: var(--bg3); border: 1px solid var(--border);
  border-radius: 8px; color: var(--text); padding: 10px 12px;
  font-size: 14px; margin-bottom: 10px; font-family: inherit;
}
.modal-sheet select { appearance: none; }
.modal-sheet .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
.modal-sheet .modal-btn {
  padding: 10px 20px; border-radius: 8px; border: none;
  font-size: 14px; font-weight: 600; cursor: pointer;
}
.modal-sheet .modal-cancel { background: var(--bg3); color: var(--text); }
.modal-sheet .modal-submit { background: var(--accent); color: var(--bg); }
</style>
</head>
<body>

<header>
  <span class="back" id="back-btn" onclick="showList()">&#x2190;</span>
  <h1 id="title-text">Overlord</h1>
  <span class="agent-name" id="agent-name-text"></span>
  <span class="status-dot" id="agent-status-dot" style="display:none"></span>
  <button class="action-btn" id="btn-restart" style="display:none" onclick="restartCurrent()">Restart</button>
  <button class="action-btn danger" id="btn-close" style="display:none" onclick="closeCurrent()">Close</button>
</header>

<div id="conn-status">Disconnected</div>

<div id="agent-list"></div>

<div id="agent-detail">
  <div id="terminal-output"></div>
  <div id="input-bar">
    <textarea id="msg-input" placeholder="Type a message..." rows="1"></textarea>
    <button id="send-btn" onclick="sendMessage()">Send</button>
  </div>
</div>

<button id="new-agent-btn" onclick="openNewAgent()">+ New Agent</button>

<div id="new-agent-modal">
  <div class="modal-sheet">
    <h3>New Agent</h3>
    <select id="project-select"><option value="">Select project...</option></select>
    <textarea id="new-prompt" placeholder="Initial prompt (optional)..." rows="3"></textarea>
    <div class="modal-actions">
      <button class="modal-btn modal-cancel" onclick="closeNewAgent()">Cancel</button>
      <button class="modal-btn modal-submit" onclick="submitNewAgent()">Create</button>
    </div>
  </div>
</div>

<script>
const agents = new Map();
let currentAgent = null;
let ws = null;
let reconnectTimer = null;

// ── ANSI stripping ──
function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
          .replace(/\x1b\][^\x07]*\x07/g, '')   // OSC sequences
          .replace(/\x1b[()][A-Z0-9]/g, '')      // charset
          .replace(/[\x00-\x09\x0b-\x0c\x0e-\x1f]/g, ''); // control chars except \n \r
}

// ── WebSocket ──
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host + '/ws');
  ws.onopen = () => {
    document.getElementById('conn-status').style.display = 'none';
    clearTimeout(reconnectTimer);
    ws.send(JSON.stringify({ type: 'getState' }));
  };
  ws.onmessage = (e) => {
    try { handleMsg(JSON.parse(e.data)); } catch {}
  };
  ws.onclose = () => {
    document.getElementById('conn-status').style.display = 'block';
    reconnectTimer = setTimeout(connect, 2000);
  };
  ws.onerror = () => ws.close();
}

function wsSend(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// ── Message handling ──
function handleMsg(msg) {
  switch (msg.type) {
    case 'fullState':
      agents.clear();
      for (const a of msg.agents) agents.set(a.id, a);
      renderList();
      break;
    case 'agentCreated':
      agents.set(msg.id, {
        id: msg.id, cwd: msg.cwd, title: msg.title || '', customName: msg.customName,
        agentName: msg.agentName || '', status: 'active', lastPrompt: '', preview: '',
        createdAt: msg.createdAt, stats: null, spinnerText: '',
      });
      renderList();
      break;
    case 'agentClosed':
      agents.delete(msg.id);
      if (currentAgent === msg.id) showList();
      renderList();
      break;
    case 'status': {
      const a = agents.get(msg.id);
      if (a) { a.status = msg.status; renderList(); updateDetailHeader(); }
      break;
    }
    case 'title': {
      const a = agents.get(msg.id);
      if (a) { a.title = msg.text; a.customName = msg.customName; renderList(); updateDetailHeader(); }
      break;
    }
    case 'prompt': {
      const a = agents.get(msg.id);
      if (a) { a.lastPrompt = msg.text; renderList(); }
      break;
    }
    case 'preview': {
      const a = agents.get(msg.id);
      if (a) { a.preview = msg.text; renderList(); }
      break;
    }
    case 'spinnerText': {
      const a = agents.get(msg.id);
      if (a) a.spinnerText = msg.text;
      break;
    }
    case 'termData': {
      if (msg.id !== currentAgent) return;
      const out = document.getElementById('terminal-output');
      const atBottom = out.scrollTop + out.clientHeight >= out.scrollHeight - 30;
      out.textContent += stripAnsi(msg.data);
      // Cap displayed text at 100K chars
      if (out.textContent.length > 100000) out.textContent = out.textContent.slice(-80000);
      if (atBottom) out.scrollTop = out.scrollHeight;
      break;
    }
    case 'stats': {
      const a = agents.get(msg.id);
      if (a) a.stats = msg.stats;
      break;
    }
    case 'projects': {
      const sel = document.getElementById('project-select');
      sel.innerHTML = '<option value="">Select project...</option>';
      for (const p of msg.projects) {
        const o = document.createElement('option');
        o.value = p;
        o.textContent = p.split(/[\\/]/).slice(-2).join('/');
        sel.appendChild(o);
      }
      break;
    }
    case 'agentNameChanged': {
      const a = agents.get(msg.id);
      if (a) { a.agentName = msg.agentName; renderList(); updateDetailHeader(); }
      break;
    }
    case 'focused': break; // ignore on mobile
    case 'remoteReady': break; // not relevant to mobile
  }
}

// ── Rendering ──
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function pathLabel(p) { return p.split(/[\\/]/).slice(-2).join('/'); }

function renderList() {
  const el = document.getElementById('agent-list');
  if (agents.size === 0) {
    el.innerHTML = '<div style="text-align:center;color:var(--dim);padding:40px 0;font-size:13px">No agents running</div>';
    return;
  }
  let html = '';
  for (const [id, a] of agents) {
    const name = a.agentName ? a.agentName + ' \u2014 ' : '';
    const title = a.customName ? a.title : (a.lastPrompt || a.title || 'New agent');
    const st = a.status || 'idle';
    html += `<div class="agent-card" onclick="viewAgent(${id})">
      <div class="agent-top">
        <span class="name">${esc(name + title)}</span>
        <span class="status status-${st}">${st}</span>
      </div>
      ${a.lastPrompt ? `<div class="agent-prompt">${esc(a.lastPrompt)}</div>` : ''}
      <div class="agent-project">${esc(pathLabel(a.cwd || ''))}</div>
    </div>`;
  }
  el.innerHTML = html;
}

function updateDetailHeader() {
  if (currentAgent === null) return;
  const a = agents.get(currentAgent);
  if (!a) return;
  const name = a.agentName || a.title || 'Agent';
  document.getElementById('agent-name-text').textContent = name;
  const dot = document.getElementById('agent-status-dot');
  const st = a.status || 'idle';
  dot.style.background = st === 'active' ? 'var(--green)' : st === 'waiting' ? 'var(--yellow)' : 'var(--dim)';
}

// ── Navigation ──
function viewAgent(id) {
  currentAgent = id;
  document.getElementById('agent-list').style.display = 'none';
  document.getElementById('new-agent-btn').style.display = 'none';
  document.getElementById('agent-detail').style.display = 'flex';
  document.getElementById('title-text').style.display = 'none';
  document.getElementById('back-btn').style.display = 'block';
  document.getElementById('agent-name-text').style.display = 'block';
  document.getElementById('agent-status-dot').style.display = 'block';
  document.getElementById('btn-restart').style.display = 'inline-block';
  document.getElementById('btn-close').style.display = 'inline-block';
  document.getElementById('terminal-output').textContent = '';
  updateDetailHeader();
  wsSend({ type: 'viewAgent', id });
}

function showList() {
  currentAgent = null;
  document.getElementById('agent-list').style.display = 'block';
  document.getElementById('new-agent-btn').style.display = 'block';
  document.getElementById('agent-detail').style.display = 'none';
  document.getElementById('title-text').style.display = 'block';
  document.getElementById('back-btn').style.display = 'none';
  document.getElementById('agent-name-text').style.display = 'none';
  document.getElementById('agent-status-dot').style.display = 'none';
  document.getElementById('btn-restart').style.display = 'none';
  document.getElementById('btn-close').style.display = 'none';
  renderList();
}

// ── Actions ──
function sendMessage() {
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text || currentAgent === null) return;
  wsSend({ type: 'termInput', id: currentAgent, data: text + '\r' });
  input.value = '';
  input.style.height = 'auto';
}

function restartCurrent() {
  if (currentAgent !== null && confirm('Restart this agent?')) {
    wsSend({ type: 'restartAgent', id: currentAgent });
    showList();
  }
}

function closeCurrent() {
  if (currentAgent !== null && confirm('Close this agent?')) {
    wsSend({ type: 'closeAgent', id: currentAgent });
    showList();
  }
}

function openNewAgent() {
  wsSend({ type: 'getProjects' });
  document.getElementById('new-agent-modal').classList.add('open');
}

function closeNewAgent() {
  document.getElementById('new-agent-modal').classList.remove('open');
}

function submitNewAgent() {
  const cwd = document.getElementById('project-select').value;
  if (!cwd) { alert('Select a project folder'); return; }
  const prompt = document.getElementById('new-prompt').value.trim();
  wsSend({ type: 'createAgent', cwd, prompt: prompt || undefined });
  document.getElementById('new-prompt').value = '';
  closeNewAgent();
}

// ── Input auto-resize ──
const msgInput = document.getElementById('msg-input');
msgInput.addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 120) + 'px';
});
msgInput.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

// ── Start ──
connect();
</script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add mobile.html
git commit -m "feat: add self-contained mobile web UI for remote agent control"
```

---

### Task 5: QR Overlay UI (`index.html`)

Add QR code button to header and overlay to display the QR code + URL.

**Files:**
- Modify: `index.html` (CSS, HTML, JS)

- [ ] **Step 1: Add QR overlay CSS**

After the `.tl-event-prompt.tl-highlight` CSS block (around line 646), add:

```css
/* ── QR overlay ── */
#qr-overlay {
  display:none; position:fixed; inset:0; background:rgba(17,17,27,.7); backdrop-filter:blur(4px); z-index:999;
  align-items:center; justify-content:center;
}
#qr-overlay .qr-modal {
  background:var(--bg2); border:1px solid var(--border); border-radius:12px;
  padding:28px 32px; text-align:center; max-width:340px;
}
#qr-overlay h3 { margin-bottom:16px; font-size:16px; }
#qr-overlay .qr-svg { margin:0 auto 16px; }
#qr-overlay .qr-url {
  font-family:'Cascadia Code','Fira Code',monospace; font-size:13px;
  color:var(--accent); word-break:break-all; margin-bottom:8px;
  user-select:all; cursor:text;
}
#qr-overlay .qr-hint { font-size:11px; color:var(--dim); }
```

- [ ] **Step 2: Add QR header button**

In the header section (around line 788), after the history button and before the settings button, add:

```html
<button class="hdr-btn" id="qr-btn" onclick="toggleQr()" title="Mobile remote (QR)" style="display:none">&#x25A3;</button>
```

- [ ] **Step 3: Add QR overlay HTML**

After the `#confirm-overlay` div (around line 929), add:

```html
<div id="qr-overlay" onclick="closeQr()">
  <div class="qr-modal" onclick="event.stopPropagation()">
    <h3>Mobile Remote</h3>
    <div class="qr-svg" id="qr-svg"></div>
    <div class="qr-url" id="qr-url"></div>
    <div class="qr-hint">Scan with your phone camera on the same network</div>
  </div>
</div>
```

- [ ] **Step 4: Add QR toggle functions in the script section**

After the `closeHelp()` function (around line 2712), add:

```javascript
// ── QR Remote overlay ──
let _remoteUrl = null;
let _qrSvg = null;
function toggleQr() {
  const el = document.getElementById('qr-overlay');
  if (el.style.display === 'flex') { closeQr(); return; }
  if (!_qrSvg) return;
  document.getElementById('qr-svg').innerHTML = _qrSvg;
  document.getElementById('qr-url').textContent = _remoteUrl;
  el.style.display = 'flex';
  el.style.opacity = '0';
  requestAnimationFrame(() => el.style.opacity = '1');
}
function closeQr() {
  const el = document.getElementById('qr-overlay');
  el.style.opacity = '0';
  setTimeout(() => { el.style.display = 'none'; }, 150);
}
```

- [ ] **Step 5: Handle `remoteReady` message in the renderer message handler**

In the `api.on((msg) => { ... })` switch statement, in the `handleAgentMsg` function (around line 2268), add a case for `remoteReady`:

```javascript
case 'remoteReady': {
  _remoteUrl = msg.url;
  _qrSvg = msg.qrSvg;
  document.getElementById('qr-btn').style.display = '';
  break;
}
```

- [ ] **Step 6: Add Escape handler for QR overlay**

In the Escape key handler (around line 2623), before the confirm overlay check, add:

```javascript
const qr = document.getElementById('qr-overlay');
if (qr.style.display === 'flex') { closeQr(); return; }
```

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "feat: add QR code overlay and header button for mobile remote"
```

---

### Task 6: Integration & Build Config

Update `package.json` build files, verify everything wires together.

**Files:**
- Modify: `package.json:35-41`

- [ ] **Step 1: Update `package.json` build files**

In the `build.files` array, add `qr.js` and `mobile.html`:

Change:
```json
"files": [
  "main.js",
  "preload.js",
  "index.html",
  "xterm-bundle.js",
  "xterm.css"
],
```

To:
```json
"files": [
  "main.js",
  "preload.js",
  "index.html",
  "xterm-bundle.js",
  "xterm.css",
  "qr.js",
  "mobile.html"
],
```

- [ ] **Step 2: Verify the app starts without errors**

Run: `cd /c/Work/overlord && npm start`

Expected:
- App opens normally
- Console shows: `[Overlord] Remote access: http://<your-ip>:7778`
- QR button (&#x25A3;) appears in header
- Clicking it shows QR code overlay with scannable QR
- Opening `http://<your-ip>:7778` in browser shows mobile UI
- Existing features unchanged

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: add qr.js and mobile.html to build files"
```

- [ ] **Step 4: Verify mobile flow end-to-end**

1. Start app
2. Create an agent in Overlord
3. Open remote URL on phone (or second browser tab)
4. Verify agent appears in mobile list
5. Tap agent — verify terminal output loads
6. Type a message and send — verify it appears in Overlord terminal
7. Close/restart agent from mobile — verify it works
8. Create new agent from mobile — verify it works
