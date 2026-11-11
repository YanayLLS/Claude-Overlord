// Is an agent's view alive and painting? Pure helpers so the verdict is testable
// without Electron. A dead or wedged view shows an all-black frame while its URL
// bar still names the page; a page that is really black is told apart by its CSS.

const SAMPLE_STRIDE = 97; // pixels; ~10k samples of a 1280x800 frame
const NEAR_BLACK = 24;    // r+g+b at or below this counts as black

// True when the frame is empty or every sampled pixel is black. toBitmap() is BGRA.
function isBlankImage(image) {
  if (!image || image.isEmpty()) return true;
  const px = image.toBitmap();
  for (let i = 0; i + 2 < px.length; i += 4 * SAMPLE_STRIDE) {
    if (px[i] + px[i + 1] + px[i + 2] > NEAR_BLACK) return false;
  }
  return true;
}

// [body, html] computed background colours, read in the page.
const BACKGROUND_PROBE = '[document.body ? getComputedStyle(document.body).backgroundColor : "", document.documentElement ? getComputedStyle(document.documentElement).backgroundColor : ""]';

// True when the page itself paints a near-black background. Transparent means the
// default white canvas, so it is not dark.
function isDarkBackground(colors) {
  if (!Array.isArray(colors)) return false;
  return colors.some((c) => {
    const m = /rgba?\(([^)]+)\)/.exec(String(c || ''));
    if (!m) return false;
    const [r, g, b, a = 1] = m[1].split(',').map((n) => parseFloat(n));
    return a > 0.5 && r + g + b <= 3 * 40;
  });
}

module.exports = { isBlankImage, isDarkBackground, BACKGROUND_PROBE };
