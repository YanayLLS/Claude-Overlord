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
  // pixels: Uint8Array of RGBA values, top-down row order
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
