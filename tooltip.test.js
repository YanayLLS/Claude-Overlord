// Run: node tooltip.test.js
const assert = require('assert');
const { tipPlacement, menuPlacement } = require('./tooltip');

const vw = 1000, vh = 800;
const rect = (left, top, w = 40, h = 20) => ({ left, top, right: left + w, bottom: top + h, width: w, height: h });

// Opens toward the side with the most room.
// Header button at the top middle → most room below
let p = tipPlacement(rect(480, 10), 100, 30, vw, vh);
assert.strictEqual(p.side, 'bottom');
assert.strictEqual(p.x, 450);                 // centred: 500 - 100/2
assert.strictEqual(p.y, 30 + 8);              // 8px gap for the arrow
assert.strictEqual(p.arrow, 50);              // arrow at the bubble's middle

// Button at the bottom middle → above
p = tipPlacement(rect(480, 770), 100, 30, vw, vh);
assert.strictEqual(p.side, 'top');
assert.strictEqual(p.y, 770 - 30 - 8);

// Sidebar row at the far left, mid-height → to its right
p = tipPlacement(rect(10, 390), 100, 30, vw, vh);
assert.strictEqual(p.side, 'right');
assert.strictEqual(p.x, 50 + 8);
assert.strictEqual(p.y, 400 - 15);            // centred vertically on the target
assert.strictEqual(p.arrow, 15);              // arrow at the bubble's vertical middle

// Terminal button at the far right, mid-height → to its left
p = tipPlacement(rect(950, 390), 100, 30, vw, vh);
assert.strictEqual(p.side, 'left');
assert.strictEqual(p.x, 950 - 100 - 8);

// Clamped inside the window; the arrow still points at the target, never into a rounded corner
p = tipPlacement(rect(975, 5, 20, 20), 100, 30, vw, 2000); // tall window: more room below than left → below, pushed left
assert.strictEqual(p.side, 'bottom');
assert.strictEqual(p.x, vw - 100 - 6);        // 6px margin from the edge
assert.strictEqual(p.arrow, Math.min(985 - p.x, 100 - 10));

// Menus: open below when it fits, else flip to whichever side has more room.
const btn = { left: 400, right: 420, top: 100, bottom: 120, width: 20, height: 20 };
let m = menuPlacement(btn, 150, 200, vw, vh);
assert.strictEqual(m.y, 124); assert.strictEqual(m.x, 400); assert.strictEqual(m.maxH, null);
const low = { left: 400, right: 420, top: 700, bottom: 720, width: 20, height: 20 };
m = menuPlacement(low, 150, 200, vw, vh);
assert.strictEqual(m.y, 700 - 4 - 200);                 // flipped above the button
m = menuPlacement(low, 150, 200, vw, vh, true);
assert.strictEqual(m.x, 420 - 150);                     // right-aligned dropdown
m = menuPlacement({ left: 400, right: 400, top: 790, bottom: 790, width: 0, height: 0 }, 150, 200, vw, vh);
assert.strictEqual(m.y, 790 - 200);                     // cursor near the bottom: menu grows upward from it
m = menuPlacement({ left: 950, right: 950, top: 10, bottom: 10, width: 0, height: 0 }, 150, 200, vw, vh);
assert.strictEqual(m.x, 950 - 150);                     // cursor near the right edge: opens to its left
m = menuPlacement({ left: 400, right: 420, top: 300, bottom: 320, width: 20, height: 20 }, 150, 900, vw, vh);
assert.strictEqual(m.y, 324); assert.strictEqual(m.maxH, 800 - 320 - 4 - 8); // fits nowhere: bigger side, scrolls

console.log('tooltip: all assertions passed');
