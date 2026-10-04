// Run: node catalog-core.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { frontmatter, scanCatalog, BUILTINS } = require('./catalog-core');

// frontmatter: quoted, plain, folded multi-line, none
assert.deepStrictEqual(frontmatter("---\nname: 'fix-bug'\ndescription: \"Fix it\"\n---\nbody"), { name: 'fix-bug', description: 'Fix it' });
assert.deepStrictEqual(frontmatter('---\ndescription: >\n  line one\n  line two\nargument-hint: <v>\n---\n'), { description: 'line one line two', 'argument-hint': '<v>' });
assert.deepStrictEqual(frontmatter('no frontmatter here'), {});

// Build a fake home + repo
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-'));
const w = (p, s) => { fs.mkdirSync(path.dirname(path.join(tmp, p)), { recursive: true }); fs.writeFileSync(path.join(tmp, p), s); };
const md = (name, desc, extra = '') => `---\nname: ${name}\ndescription: ${desc}\n${extra}---\n`;

w('home/.claude/skills/run/SKILL.md', md('run', 'pc run'));
w('home/.claude/skills/storify/SKILL.md', md('storify', 'tell a story'));
w('home/.claude/skills/synced/abc_123/SKILL.md', md('one-status', 'status page')); // nested one level
w('home/.claude/commands/fix-bug.md', md('fix-bug', 'fix a bug', 'argument-hint: <ticket>\n'));
w('home/.claude/commands/fl/review.md', md('', 'namespaced')); // → fl:review
w('home/.claude/agents/reviewer.md', md('code-reviewer', 'reviews diffs'));
w('repo/.claude/skills/run/SKILL.md', md('run', 'repo run'));
w('repo/.claude/commands/release.md', '# Cut a release\nmore text');
w('home/.claude/settings.json', JSON.stringify({ enabledPlugins: { 'sp@mk': true, 'off@mk': false } }));
w('plug/sp/skills/brainstorming/SKILL.md', md('brainstorming', 'design first'));
w('plug/sp/commands/go.md', md('go', 'go'));
w('plug/off/skills/hidden/SKILL.md', md('hidden', 'disabled plugin'));
w('home/.claude/plugins/installed_plugins.json', JSON.stringify({ plugins: {
  'sp@mk': [{ installPath: path.join(tmp, 'plug/sp') }],
  'off@mk': [{ installPath: path.join(tmp, 'plug/off') }],
} }));

const items = scanCatalog(path.join(tmp, 'repo'), path.join(tmp, 'home'));
const find = (type, name, origin) => items.find(i => i.type === type && i.name === name && (!origin || i.origin === origin));

// origins
assert.strictEqual(find('skill', 'run', 'repo').desc, 'repo run');
assert.strictEqual(find('skill', 'storify').origin, 'pc');
assert.ok(find('skill', 'one-status', 'pc'), 'nested synced skill found');
assert.strictEqual(find('command', 'fix-bug').hint, '<ticket>');
assert.ok(find('command', 'fl:review'), 'subdir command is namespaced');
assert.strictEqual(find('agent', 'code-reviewer').origin, 'pc');
assert.strictEqual(find('command', 'release').desc, 'Cut a release', 'no frontmatter → first text line');

// shadowing: repo wins over pc for same type+name
assert.strictEqual(find('skill', 'run', 'repo').shadowed, undefined);
assert.strictEqual(find('skill', 'run', 'pc').shadowed, 'repo');

// plugins: enabled only, namespaced with plugin name, group = plugin · marketplace
const bs = find('skill', 'sp:brainstorming');
assert.strictEqual(bs.origin, 'plugin');
assert.strictEqual(bs.group, 'sp · mk');
assert.ok(find('command', 'sp:go'));
assert.ok(!items.some(i => /hidden/.test(i.name)), 'disabled plugin skipped');

// built-ins present, insert text is "/name "
assert.ok(BUILTINS.length > 5);
assert.ok(find('builtin', 'compact'));
assert.strictEqual(find('command', 'fix-bug').insert, '/fix-bug ');
assert.strictEqual(find('agent', 'code-reviewer').insert, 'Use the code-reviewer agent to ');

// missing dirs don't throw
assert.ok(Array.isArray(scanCatalog(path.join(tmp, 'nope'), path.join(tmp, 'nohome'))));

fs.rmSync(tmp, { recursive: true, force: true });
console.log('catalog-core ok');
