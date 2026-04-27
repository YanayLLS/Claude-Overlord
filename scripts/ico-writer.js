'use strict';
const fs  = require('fs');
const path = require('path');
const { hex, fillRect, drawCircle } = require('./bmp-writer');

function makeIconImage(size) {
  const px    = new Uint8Array(size * size * 4);
  const purp  = hex('#7c3aed');
  const purpL = hex('#a855f7');
  const white = hex('#ffffff');
  const bg    = hex('#0d1117');
  const half  = size / 2;
  fillRect(px, size, 0, 0, size, size, bg);
  drawCircle(px, size, half, half, half - 1, purp);
  drawCircle(px, size, half, half, Math.round(half * 0.6), purpL);
  drawCircle(px, size, half, half, Math.round(half * 0.25), white);
  return px;
}

function icoEntry(size, pixels) {
  const rowSize       = size * 4;           // 32bpp: always aligned
  const pixelDataSize = rowSize * size;
  const bmpHeaderSize = 40;
  const buf           = Buffer.alloc(bmpHeaderSize + pixelDataSize, 0);

  buf.writeUInt32LE(40, 0);
  buf.writeInt32LE(size, 4);
  buf.writeInt32LE(size * 2, 8);  // height * 2 for ICO XOR+AND masks
  buf.writeUInt16LE(1, 12);
  buf.writeUInt16LE(32, 14);
  buf.writeUInt32LE(0, 16);       // BI_RGB (was BI_BITFIELDS — bug fix)
  buf.writeUInt32LE(pixelDataSize, 20);

  // Write BGRA pixels bottom-up (fixed dst formula — bug fix)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4;
      const dst = bmpHeaderSize + (size - 1 - y) * rowSize + x * 4;
      buf[dst]     = pixels[src + 2]; // B
      buf[dst + 1] = pixels[src + 1]; // G
      buf[dst + 2] = pixels[src];     // R
      buf[dst + 3] = pixels[src + 3]; // A
    }
  }
  return buf;
}

function writeIco(outputPath) {
  const sizes  = [16, 32, 48, 256];
  const images = sizes.map(s => ({ size: s, data: icoEntry(s, makeIconImage(s)) }));

  const dirSize = 6 + sizes.length * 16;
  let offset    = dirSize;
  const parts   = [];

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  parts.push(header);

  const dir = Buffer.alloc(sizes.length * 16);
  images.forEach(({ size, data }, i) => {
    const off      = i * 16;
    dir[off]       = size === 256 ? 0 : size;
    dir[off + 1]   = size === 256 ? 0 : size;
    dir[off + 2]   = 0;
    dir[off + 3]   = 0;
    dir.writeUInt16LE(1, off + 4);
    dir.writeUInt16LE(32, off + 6);
    dir.writeUInt32LE(data.length, off + 8);
    dir.writeUInt32LE(offset, off + 12);
    offset += data.length;
  });
  parts.push(dir);
  images.forEach(({ data }) => parts.push(data));

  fs.writeFileSync(outputPath, Buffer.concat(parts));
  console.log(`  Created: assets/icon.ico`);
}

module.exports = { writeIco };
