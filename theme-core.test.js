// Run: node theme-core.test.js
const assert = require('assert');
const { THEMES, themeOf, xtermTheme, titleBarColors } = require('./theme-core');

// The five themes, Midnight first (the default)
assert.deepStrictEqual(Object.keys(THEMES), ['midnight', 'graphite', 'nord', 'catppuccin', 'light']);
// Unknown or missing names fall back to Midnight
assert.strictEqual(themeOf('nope'), THEMES.midnight);
assert.strictEqual(themeOf(undefined), THEMES.midnight);
// The terminal gets the theme's background, and keeps a full ANSI palette
assert.strictEqual(xtermTheme('nord').background, THEMES.nord.term);
assert.ok(xtermTheme('nord').brightWhite);
// Light keeps a dark terminal with light text: Claude's colors assume a dark background
const lt = xtermTheme('light');
assert.strictEqual(lt.background, '#18181b');
assert.strictEqual(lt.foreground, '#e4e4e7');
// The Windows title bar matches the header
assert.deepStrictEqual(titleBarColors('light'), { color: THEMES.light.bg, symbolColor: THEMES.light.symbol });

console.log('theme-core: all assertions passed');
