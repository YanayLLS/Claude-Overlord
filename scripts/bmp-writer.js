'use strict';
const fs   = require('fs');
const path = require('path');

function writeBmp(filePath, width, height, pixels) {
  const rowSize      = Math.ceil((width * 3) / 4) * 4;
  const pixelDataSize = rowSize * height;
  const fileSize     = 54 + pixelDataSize;
  const buf          = Buffer.alloc(fileSize, 0);

  buf.write('BM', 0);
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(-height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(0, 30);
  buf.writeUInt32LE(pixelDataSize, 34);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = 54 + y * rowSize + x * 3;
      buf[dst]     = pixels[src + 2];
      buf[dst + 1] = pixels[src + 1];
      buf[dst + 2] = pixels[src];
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
      [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]] = [...color, 255];
    }
  }
}

function drawHorizontalGradient(pixels, w, x0, y0, x1, y1, colorA, colorB) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const t  = (x - x0) / Math.max(1, x1 - x0 - 1);
      const i  = (y * w + x) * 4;
      pixels[i]     = Math.round(colorA[0] + t * (colorB[0] - colorA[0]));
      pixels[i + 1] = Math.round(colorA[1] + t * (colorB[1] - colorA[1]));
      pixels[i + 2] = Math.round(colorA[2] + t * (colorB[2] - colorA[2]));
      pixels[i + 3] = 255;
    }
  }
}

function drawCircle(pixels, w, cx, cy, r, color) {
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || y < 0) continue;
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) {
        const i = (y * w + x) * 4;
        [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]] = [...color, 255];
      }
    }
  }
}

module.exports = { writeBmp, hex, fillRect, drawHorizontalGradient, drawCircle };
