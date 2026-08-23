// Run: node recover-core.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanSessions, mergeRecovered } = require('./recover-core');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recover-test-'));
const proj = (slug) => { const d = path.join(root, slug); fs.mkdirSync(d, { recursive: true }); return d; };
const write = (dir, id, lines) => {
  const f = path.join(dir, id + '.jsonl');
  fs.writeFileSync(f, lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'));
  return f;
};

const repo = proj('C--Work-repo');
write(repo, 'aaa', [
  { type: 'user', cwd: 'C:\\Work\\repo', message: { content: 'fix the login bug\nsecond line' } },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
  '{"type":"user","cwd":"C:\\\\Work', // truncated last line — must not throw
]);
// system-injected first message must not become the title
write(repo, 'bbb', [
  { type: 'user', cwd: 'C:\\Work\\repo', message: { content: '<command-name>/init</command-name>' } },
  { type: 'user', cwd: 'C:\\Work\\repo', message: { content: [{ type: 'text', text: 'real prompt' }] } },
]);
// no cwd anywhere → not recoverable, skipped rather than guessed from the dir name
write(proj('C--Work-other'), 'ccc', [{ type: 'user', message: { content: 'hi' } }]);
// stale: outside the day window
const old = write(repo, 'ddd', [{ type: 'user', cwd: 'C:\\Work\\repo', message: { content: 'ancient' } }]);
fs.utimesSync(old, new Date(Date.now() - 30 * 86400e3), new Date(Date.now() - 30 * 86400e3));
// empty file → skipped
write(repo, 'eee', []);
// same session under a worktree dir and the parent repo: the bigger one wins, once
const wt = proj('C--Work-repo--worktrees-x');
write(wt, 'aaa', [{ type: 'user', cwd: 'C:\\Work\\repo\\wt', message: { content: 'resumed here '.repeat(60) } }]);

const found = scanSessions(root, 2);
const ids = found.map(a => a.sessionId).sort();
assert.deepStrictEqual(ids, ['aaa', 'bbb'], 'only recent transcripts carrying a cwd');
assert.strictEqual(found.filter(a => a.sessionId === 'aaa').length, 1, 'duplicate session collapsed');
assert.strictEqual(found.find(a => a.sessionId === 'aaa').cwd, 'C:\\Work\\repo\\wt', 'bigger transcript wins');
assert.strictEqual(found.find(a => a.sessionId === 'bbb').title, 'real prompt', 'system message is not a title');
assert.ok(found.every(a => a.archived), 'recovered agents arrive archived');
assert.ok(found.every(a => a.stats && a.stats.turns === 0), 'zeroed stats, so restore skips the re-parse');

// missing projects dir is not an error — a machine with no transcripts recovers nothing
assert.deepStrictEqual(scanSessions(path.join(root, 'nope'), 2), []);

// merge keeps what's already there and re-derives projects + bookmarks from cwds
const state = { agents: [{ sessionId: 'aaa', cwd: 'C:\\Work\\repo', keep: true }], settings: {} };
const added = mergeRecovered(state, found);
assert.strictEqual(added, 1, 'already-known session is not duplicated');
assert.strictEqual(state.agents.length, 2);
assert.strictEqual(state.agents[0].keep, true, 'existing entry untouched');
// 'aaa' was already known, so its worktree cwd never enters — only 'bbb' brings one
assert.deepStrictEqual(state.settings.knownProjects, ['C:\\Work\\repo']);
assert.deepStrictEqual(state.settings.bookmarks.map(b => b.name), ['repo']);

// merging again changes nothing
assert.strictEqual(mergeRecovered(state, found), 0);
assert.strictEqual(state.settings.bookmarks.length, 1);

fs.rmSync(root, { recursive: true, force: true });
console.log('recover-core: all tests passed');
