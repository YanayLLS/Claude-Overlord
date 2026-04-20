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
  // (The exact remainder bits are: v1:0, v2:7, v3:7, v4:7, v5:7, v6:7, v7:0...
  // Correct remainder bits: v1:0, v2-6:7, v7-13:0 ... no wait)
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
  // Copy 1: L-shaped strip around top-left finder
  for (let i = 0; i <= 5; i++)
    matrix[8][i] = (bits >> i) & 1;
  matrix[8][7] = (bits >> 6) & 1;
  matrix[8][8] = (bits >> 7) & 1;
  matrix[7][8] = (bits >> 8) & 1;
  for (let i = 9; i < 15; i++)
    matrix[14 - i][8] = (bits >> i) & 1;
  // Copy 2: bottom-left (vertical) and top-right (horizontal)
  for (let i = 0; i < 8; i++)
    matrix[size - 1 - i][8] = (bits >> i) & 1;
  for (let i = 8; i < 15; i++)
    matrix[8][size - 15 + i] = (bits >> i) & 1;
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
