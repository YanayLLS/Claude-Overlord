const test = require('node:test');
const assert = require('node:assert');
const { cleanText } = require('./whisper');

test('silence and noise come back as no words, not a dash', () => {
  for (const s of [' - ', '-', '...', ' [BLANK_AUDIO] ', '(wind blowing)', ' — ', '- [Music]']) assert.strictEqual(cleanText(s), '', JSON.stringify(s));
  assert.strictEqual(cleanText(' - Fix the bug.\n - Then commit.'), 'Fix the bug. Then commit.');
  assert.strictEqual(cleanText('Check the read-only flag - twice.'), 'Check the read-only flag - twice.'); // dashes inside a sentence stay
});
