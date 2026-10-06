const { test } = require('node:test');
const assert = require('node:assert');
const { mentionQuery, rankMembers, toBlocks, normalizeMembers } = require('./mention-core');

test('mention query: only an @ that starts a word, up to the caret', () => {
  assert.deepStrictEqual(mentionQuery('hello @Ya'), { query: 'Ya', start: 6 });
  assert.deepStrictEqual(mentionQuery('@'), { query: '', start: 0 });
  assert.strictEqual(mentionQuery('mail me at a@b'), null);
  assert.strictEqual(mentionQuery('hello @Yanay done'), null);
});

test('members rank by how the name matches', () => {
  const ms = [{ name: 'Yoni Veinberg', email: 'yoni@x' }, { name: 'Yanay Nadel', email: 'yanay@x' }, { name: 'Marcelo Goycochea', email: 'm@x' }];
  assert.deepStrictEqual(rankMembers(ms, 'ya').map(m => m.name), ['Yanay Nadel']);
  assert.deepStrictEqual(rankMembers(ms, 'nad').map(m => m.name), ['Yanay Nadel']);
  assert.deepStrictEqual(rankMembers(ms, '').map(m => m.name), ['Marcelo Goycochea', 'Yanay Nadel', 'Yoni Veinberg']);
  assert.deepStrictEqual(rankMembers(ms, 'zzz'), []);
});

test('blocks: text runs merge, mentions become tag blocks, outer whitespace trimmed', () => {
  const r = toBlocks([{ text: '  ' }, { tag: '42', name: 'Yanay Nadel' }, { text: ' can you ' }, { text: 'look?' }, { text: '  ' }]);
  assert.deepStrictEqual(r.blocks, [{ type: 'tag', user: { id: 42 } }, { text: ' can you look?', attributes: {} }]);
  assert.strictEqual(r.text, '@Yanay Nadel can you look?');
  assert.strictEqual(r.hasMention, true);
  const plain = toBlocks([{ text: 'just text' }]);
  assert.deepStrictEqual(plain.blocks, [{ text: 'just text', attributes: {} }]);
  assert.strictEqual(plain.hasMention, false);
});

test('members normalise from the team payload', () => {
  const ms = normalizeMembers({ members: [{ user: { id: 7, username: 'Zed', email: 'z@x', color: '#f00', profilePicture: null, initials: 'ZD' } }, { user: { id: 3, username: 'Amy' } }, { user: null }] });
  assert.deepStrictEqual(ms.map(m => [m.id, m.name, m.initials]), [['3', 'Amy', 'AM'], ['7', 'Zed', 'ZD']]);
});
