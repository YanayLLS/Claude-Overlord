// Run: node clickup-core.test.js
const assert = require('assert');
const { statusMatches, phaseOf, platformKey, sanitizePlatformMap, parseStatusFilter, fieldLabels, normalizeTask, assignedTo, diffRaids, taskQuery, buildTree, flattenTree, sanitizeLists } = require('./clickup-core');

// ── status matching: emoji, case and per-list copies do not matter ──
assert.ok(statusMatches('failed qa 🐞', ['failed qa']));
assert.ok(statusMatches('FAILED QA', 'failed qa'));
assert.ok(statusMatches('failed qa', ['waiting for merge', 'failed qa']));
assert.ok(!statusMatches('failed in last sprint', ['failed qa']));
assert.ok(!statusMatches('failed', ['failed qa']));           // prefix goes one way only
assert.ok(statusMatches('failed qa again', ['failed qa']));   // a longer status with the same first words still counts
assert.ok(!statusMatches('', ['failed qa']));
assert.ok(!statusMatches('failed qa', []));
assert.deepStrictEqual(parseStatusFilter(' failed qa, waiting for merge;failed qa\n'), ['failed qa', 'waiting for merge']);
assert.deepStrictEqual(parseStatusFilter(''), []);

assert.strictEqual(phaseOf('failed qa 🐞', ['failed qa'], ['in development']), 'raid');
assert.strictEqual(phaseOf('in development 🛠', ['failed qa'], ['in development']), 'fight');
assert.strictEqual(phaseOf('waiting for merge', ['failed qa'], ['in development']), null);
assert.strictEqual(phaseOf('failed qa', ['failed qa'], ['failed qa']), 'raid'); // raid wins a tie
assert.strictEqual(platformKey('Android 🤖'), 'android'); assert.strictEqual(platformKey(' XR Headset '), 'xr headset');
assert.deepStrictEqual(sanitizePlatformMap({ 'Android 🤖': 'D:\Repos\Frontline One Android', '': 'x', bad: 5, ' ': 'y' }), { android: 'D:\Repos\Frontline One Android' });
assert.deepStrictEqual(sanitizePlatformMap(null), {});

// ── custom field values ──
const PLAT = { id: 'f6b4', name: 'Platform', type: 'labels', type_config: { options: [{ id: 'a', label: 'Webapp 🌐' }, { id: 'b', label: 'Android 🤖' }] }, value: ['b', 'a'] };
assert.deepStrictEqual(fieldLabels(PLAT), ['Android 🤖', 'Webapp 🌐']);
assert.deepStrictEqual(fieldLabels({ ...PLAT, value: null }), []);
assert.deepStrictEqual(fieldLabels({ type: 'drop_down', type_config: { options: [{ id: 'x', name: 'PC', orderindex: 0 }, { id: 'y', name: 'Mac', orderindex: 1 }] }, value: 1 }), ['Mac']);
assert.deepStrictEqual(fieldLabels({ type: 'drop_down', type_config: { options: [{ id: 'x', name: 'PC' }] }, value: 'x' }), ['PC']);
assert.deepStrictEqual(fieldLabels({ type: 'short_text', value: ' iOS ' }), ['iOS']);
assert.deepStrictEqual(fieldLabels(null), []);

// ── task normalisation ──
const RAW = { id: '86c8v3cj1', name: ' Procedure | Rich text ', url: 'https://app.clickup.com/t/86c8v3cj1', status: { status: 'failed qa 🐞' }, priority: { id: '2', priority: 'high' },
  assignees: [{ id: 102713071, username: 'Noam Avitan' }, { email: 'x@y' }], tags: [{ name: 'claude' }], list: { id: 901525401034, name: 'Sprint App 57' }, date_created: '1757000000000', custom_fields: [{ id: 'zz', name: 'Version' }, PLAT] };
const t = normalizeTask(RAW, { platformField: 'f6b4' });
assert.deepStrictEqual(t, { id: '86c8v3cj1', name: 'Procedure | Rich text', url: 'https://app.clickup.com/t/86c8v3cj1', status: 'failed qa 🐞', priority: 'high', platforms: ['Android 🤖', 'Webapp 🌐'],
  list: { id: '901525401034', name: 'Sprint App 57' }, assignees: ['Noam Avitan', 'x@y'], assigneeIds: ['102713071'], tags: ['claude'], created: 1757000000000 });
assert.deepStrictEqual(normalizeTask({ ...RAW, priority: null, custom_fields: [], list: null, url: null }).priority, 'none'); // no priority is its own tier
assert.strictEqual(normalizeTask({ ...RAW, url: null }).url, 'https://app.clickup.com/t/86c8v3cj1');
assert.deepStrictEqual(normalizeTask(RAW).platforms, ['Android 🤖', 'Webapp 🌐']); // found by field name when no id is configured
assert.strictEqual(normalizeTask(null), null);
assert.ok(assignedTo(t, 102713071)); assert.ok(assignedTo(t, '102713071'));
assert.ok(!assignedTo(t, 66898146)); assert.ok(!assignedTo(t, null)); assert.ok(!assignedTo(null, 1));
assert.strictEqual(normalizeTask({ ...RAW, priority: { priority: 'weird' } }).priority, 'none');

// ── diff: first-seen memory, spawns and kills ──
const A = { id: 'a' }, B = { id: 'b' }, C = { id: 'c' };
let d = diffRaids([A, B], {}, 1000, false);              // first poll: seed silently
assert.deepStrictEqual(d, { seen: { a: 1000, b: 1000 }, spawned: [], slain: [] });
d = diffRaids([B, C], d.seen, 2000, true);
assert.deepStrictEqual(d.seen, { b: 1000, c: 2000 });     // b keeps its first-seen time
assert.deepStrictEqual(d.spawned, [C]);
assert.deepStrictEqual(d.slain, ['a']);
d = diffRaids([], d.seen, 3000, true);
assert.deepStrictEqual(d, { seen: {}, spawned: [], slain: ['b', 'c'] });
assert.deepStrictEqual(diffRaids([A], null, 5, true).seen, { a: 5 });

// ── query builder ──
assert.strictEqual(taskQuery('25595975', ['1', 2], 0), '/team/25595975/task?list_ids%5B%5D=1&list_ids%5B%5D=2&include_closed=false&subtasks=true&page=0');
assert.ok(taskQuery('1', [], 3).endsWith('page=3'));
assert.strictEqual(taskQuery('1', ['9'], 0, 66898146), '/team/1/task?list_ids%5B%5D=9&assignees%5B%5D=66898146&include_closed=false&subtasks=true&page=0');
assert.ok(!taskQuery('1', ['9'], 0, '').includes('assignees'));

// ── hierarchy tree ──
const tree = buildTree(
  [{ id: 1, name: 'Development' }, { id: 2, name: 'Old', archived: true }, { id: 3, name: 'QA' }],
  { 1: [{ id: 10, name: 'Web Sprints' }, { id: 11, name: 'Gone', archived: true }] },
  { 10: [{ id: 100, name: 'Sprint Web 38' }, { id: 101, name: 'Archived one', archived: true }] },
  { 1: [{ id: 200, name: 'Releases' }], 3: [{ id: 300, name: 'Customer Bugs' }] });
assert.deepStrictEqual(tree, [
  { id: '1', name: 'Development', folders: [{ id: '10', name: 'Web Sprints', lists: [{ id: '100', name: 'Sprint Web 38', path: 'Development / Web Sprints / Sprint Web 38' }] }], lists: [{ id: '200', name: 'Releases', path: 'Development / Releases' }] },
  { id: '3', name: 'QA', folders: [], lists: [{ id: '300', name: 'Customer Bugs', path: 'QA / Customer Bugs' }] }]);
assert.deepStrictEqual(flattenTree(tree).map(l => l.id), ['100', '200', '300']);
// folders that already carry their lists (the folder endpoint returns them inline) need no list lookup
assert.deepStrictEqual(buildTree([{ id: 1, name: 'S' }], { 1: [{ id: 10, name: 'F', lists: [{ id: 5, name: 'L' }] }] }, {}, {})[0].folders[0].lists, [{ id: '5', name: 'L', path: 'S / F / L' }]);

// ── stored lists ──
assert.deepStrictEqual(sanitizeLists([{ id: 901525276068, name: 'Sprint Web 38', path: 'a / b' }, { id: 'nope' }, { id: '901525276068', name: 'dup' }, null]), [{ id: '901525276068', name: 'Sprint Web 38', path: 'a / b' }]);
assert.deepStrictEqual(sanitizeLists(undefined), []);

console.log('ok — all clickup-core checks passed');
