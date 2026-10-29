// Self-check for folders-core. Run: node folders-core.test.js
const assert = require('assert');
const { newFolder, folderOf, setFolder, renameFolder, removeFolder, moveFolder, splitByFolder } = require('./folders-core');

let { list, id: a } = newFolder([], 'Bugs');
const r = newFolder(list, 'Stories'); list = r.list; const b = r.id;
assert.deepStrictEqual(list.map(f => f.name), ['Bugs', 'Stories']);
assert.notStrictEqual(a, b);

list = setFolder(list, 'x', a);
list = setFolder(list, 'y', a);
assert.strictEqual(folderOf(list, 'x').id, a);
list = setFolder(list, 'x', b);                       // moving leaves the old folder
assert.deepStrictEqual(list.map(f => f.agents), [['y'], ['x']]);
list = setFolder(list, 'x', null);                    // out of every folder
assert.strictEqual(folderOf(list, 'x'), null);

list = renameFolder(list, a, 'Bugfix');
assert.strictEqual(list[0].name, 'Bugfix');

assert.deepStrictEqual(moveFolder(list, a, b, true).map(f => f.id), [b, a]);
assert.deepStrictEqual(moveFolder(list, b, a, false).map(f => f.id), [b, a]);
assert.strictEqual(moveFolder(list, a, a, true), list);

// Rows keep their incoming order; folder rows group by folder order, the rest are loose.
const rows = [[1, { agentName: 'z' }], [2, { agentName: 'y' }], [3, { agentName: 'w' }]];
const s = splitByFolder(list, rows);
assert.deepStrictEqual(s.folders.map(g => g.rows.map(x => x[0])), [[2], []]);
assert.deepStrictEqual(s.loose.map(x => x[0]), [1, 3]);

// A custom key: agents restored without a name go by session id.
assert.deepStrictEqual(splitByFolder(setFolder(list, 's:q', a), [[9, { sessionId: 'q' }]], x => x.agentName || 's:' + x.sessionId).folders[0].rows.map(x => x[0]), [9]);

// Removing a folder frees its agents.
list = removeFolder(list, a);
assert.strictEqual(folderOf(list, 'y'), null);
assert.deepStrictEqual(splitByFolder(undefined, rows).loose.length, 3);
console.log('folders-core ok');
