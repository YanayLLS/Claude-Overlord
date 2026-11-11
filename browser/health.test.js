const test = require('node:test');
const assert = require('node:assert');
const { isBlankImage, isDarkBackground, BACKGROUND_PROBE } = require('./health');

// toBitmap() is BGRA, 4 bytes a pixel.
const image = (pixels, { empty = false } = {}) => ({
  isEmpty: () => empty,
  toBitmap: () => Buffer.from(pixels.flatMap(([r, g, b]) => [b, g, r, 255])),
});
const fill = (n, px) => Array.from({ length: n }, () => px);

test('an all-black frame is blank', () => {
  assert.strictEqual(isBlankImage(image(fill(5000, [0, 0, 0]))), true);
});

test('an empty image is blank', () => {
  assert.strictEqual(isBlankImage(image([], { empty: true })), true);
});

test('a frame with any real content is not blank', () => {
  const px = fill(5000, [0, 0, 0]);
  for (let i = 0; i < px.length; i += 50) px[i] = [240, 240, 240]; // a line of text
  assert.strictEqual(isBlankImage(image(px)), false);
});

test('a white page is not blank', () => {
  assert.strictEqual(isBlankImage(image(fill(5000, [255, 255, 255]))), false);
});

test('dark backgrounds: an opaque near-black body or html is dark', () => {
  assert.strictEqual(isDarkBackground(['rgb(0, 0, 0)', 'rgba(0, 0, 0, 0)']), true);
  assert.strictEqual(isDarkBackground(['rgba(0, 0, 0, 0)', 'rgb(10, 12, 14)']), true);
});

test('light or transparent backgrounds are not dark (a transparent page paints white)', () => {
  assert.strictEqual(isDarkBackground(['rgb(255, 255, 255)', 'rgba(0, 0, 0, 0)']), false);
  assert.strictEqual(isDarkBackground(['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)']), false);
  assert.strictEqual(isDarkBackground(['', '']), false);
  assert.strictEqual(isDarkBackground(null), false);
});

test('the background probe is a self-contained expression', () => {
  assert.match(BACKGROUND_PROBE, /getComputedStyle/);
  assert.doesNotThrow(() => new Function(`return ${BACKGROUND_PROBE}`));
});
