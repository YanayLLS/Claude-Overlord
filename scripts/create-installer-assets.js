#!/usr/bin/env node
// Generates BMP installer graphics and a minimal ICO icon for Overlord.
// Colors: dark background #0d1117, accent purple #7c3aed, white text.
// Run: node scripts/create-installer-assets.js
'use strict';
const fs   = require('fs');
const path = require('path');
const { writeBmp, hex, fillRect, drawHorizontalGradient, drawCircle } = require('./bmp-writer');
const { writeIco } = require('./ico-writer');

const ASSETS = path.join(__dirname, '..', 'assets');
fs.mkdirSync(ASSETS, { recursive: true });

// ── Sidebar: 164×314 ──────────────────────────────────────────────────────────
function drawSidebar() {
  const W = 164, H = 314;
  const px    = new Uint8Array(W * H * 4);
  const bg    = hex('#0d1117');
  const dark  = hex('#161b22');
  const purp  = hex('#7c3aed');
  const purpL = hex('#a855f7');
  const white = hex('#ffffff');
  const gray  = hex('#8b949e');

  fillRect(px, W, 0, 0, W, H, bg);
  drawHorizontalGradient(px, W, 0, 0, W, H, dark, bg);
  fillRect(px, W, 0, 0, 3, H, purp);
  drawCircle(px, W, 82, 80, 38, purp);
  drawCircle(px, W, 82, 80, 30, dark);
  drawCircle(px, W, 82, 80, 18, purpL);
  drawCircle(px, W, 82, 80, 8, white);
  fillRect(px, W, 20, 136, W - 20, 138, purp);
  for (let i = 0; i < 5; i++) {
    drawCircle(px, W, 20 + i * 12, H - 30, 3, i === 0 ? purp : gray);
  }
  writeBmp(path.join(ASSETS, 'installer-sidebar.bmp'), W, H, px);
}

// ── Header: 150×57 ────────────────────────────────────────────────────────────
function drawHeader() {
  const W = 150, H = 57;
  const px    = new Uint8Array(W * H * 4);
  const bg    = hex('#0d1117');
  const purp  = hex('#7c3aed');
  const purpL = hex('#a855f7');
  const white = hex('#ffffff');

  fillRect(px, W, 0, 0, W, H, bg);
  drawHorizontalGradient(px, W, 0, H - 8, W, H, purp, bg);
  drawCircle(px, W, 20, 28, 14, purp);
  drawCircle(px, W, 20, 28, 8, purpL);
  drawCircle(px, W, 20, 28, 3, white);
  writeBmp(path.join(ASSETS, 'installer-header.bmp'), W, H, px);
}

drawSidebar();
drawHeader();
writeIco(path.join(ASSETS, 'icon.ico'));

console.log('\nDone. Review assets/ folder.');
