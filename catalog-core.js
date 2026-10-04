// What the "+" / "//" popover lists: skills, commands, subagents and built-ins,
// tagged by where they live (this repo, ~/.claude, an enabled plugin, Claude itself).
// Main scans once per cwd; the renderer filters (catalog-pick.js).

const fs = require('fs');
const path = require('path');

// ponytail: hand-picked, not read from Claude — add new built-ins as Claude ships them
const BUILTINS = [
  ['clear', 'Clear the conversation'], ['compact', 'Summarise the conversation to free context', '[instructions]'],
  ['context', 'Show context usage'], ['cost', 'Show token usage and cost'], ['model', 'Switch model', '[model]'],
  ['review', 'Review a pull request', '[pr]'], ['init', 'Write a CLAUDE.md for this repo'],
  ['memory', 'Edit memory files'], ['config', 'Open settings'], ['mcp', 'Manage MCP servers'],
  ['agents', 'Manage subagents'], ['permissions', 'Manage tool permissions'], ['hooks', 'Manage hooks'],
  ['plugin', 'Manage plugins'], ['resume', 'Resume a past conversation'], ['rewind', 'Rewind code and conversation'],
  ['status', 'Show version, model and account'], ['doctor', 'Check the installation'], ['help', 'Show help'],
  ['add-dir', 'Add a working directory', '<path>'], ['export', 'Export the conversation'],
  ['todos', 'Show the todo list'], ['usage', 'Show plan usage limits'], ['vim', 'Toggle vim mode'],
  ['bashes', 'List background shells'], ['statusline', 'Set up the status line'],
  ['security-review', 'Security review of pending changes'], ['output-style', 'Switch output style'],
].map(([name, desc, hint]) => ({ type: 'builtin', name, desc, hint, origin: 'builtin', group: 'Built-in', insert: `/${name} ` }));

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const dirs = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; } };
const json = (p) => { try { return JSON.parse(read(p)); } catch { return null; } };
const unquote = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2');

// ponytail: flat key: value YAML plus folded/literal blocks — enough for skill headers
function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text || '');
  if (!m) return {};
  const out = {}, lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2];
    if (/^[>|][-+]?$/.test(v.trim())) {
      const block = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim());
      v = block.join(' ');
    }
    out[kv[1]] = unquote(v);
  }
  return out;
}

// First real line of the body when there's no description.
const firstLine = (text) => (text || '').replace(/^---[\s\S]*?\n---/, '').split(/\r?\n/)
  .map(l => l.replace(/^#+\s*/, '').trim()).find(Boolean) || '';

function entry(type, file, fallbackName, base) {
  const text = read(file);
  if (text == null) return null;
  const fm = frontmatter(text);
  return { ...base, type, name: fm.name || fallbackName, desc: fm.description || firstLine(text), hint: fm['argument-hint'] || undefined, path: file };
}

// skills/<name>/SKILL.md; a folder without SKILL.md is searched one level down (claude.ai synced skills).
function scanSkills(dir, base, depth = 0) {
  const out = [];
  for (const d of dirs(dir)) {
    if (!d.isDirectory()) continue;
    const e = entry('skill', path.join(dir, d.name, 'SKILL.md'), d.name, base);
    if (e) out.push(e);
    else if (depth === 0) out.push(...scanSkills(path.join(dir, d.name), base, 1));
  }
  return out;
}

// commands/*.md and agents/*.md; command subfolders namespace as sub:name.
function scanMd(type, dir, base, prefix = '') {
  const out = [];
  for (const d of dirs(dir)) {
    const p = path.join(dir, d.name);
    if (d.isDirectory() && type === 'command') out.push(...scanMd(type, p, base, prefix + d.name + ':'));
    else if (d.isFile() && d.name.endsWith('.md')) {
      const e = entry(type, p, d.name.slice(0, -3), base);
      if (e) out.push({ ...e, name: prefix + e.name });
    }
  }
  return out;
}

function scanRoot(root, base) {
  return [...scanSkills(path.join(root, 'skills'), base),
    ...scanMd('command', path.join(root, 'commands'), base),
    ...scanMd('agent', path.join(root, 'agents'), base)];
}

function enabledPlugins(cwd, home) {
  const on = {};
  for (const f of [path.join(home, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json')])
    Object.assign(on, json(f)?.enabledPlugins || {});
  return on;
}

function scanPlugins(cwd, home) {
  const on = enabledPlugins(cwd, home), installed = json(path.join(home, '.claude', 'plugins', 'installed_plugins.json'))?.plugins || {};
  const out = [];
  for (const [key, installs] of Object.entries(installed)) {
    if (!on[key]) continue;
    const [plugin, market] = key.split('@');
    const inst = (installs || []).find(i => !i.projectPath || path.resolve(i.projectPath) === path.resolve(cwd)) || (installs || [])[0];
    if (!inst?.installPath) continue;
    for (const e of scanRoot(inst.installPath, { origin: 'plugin', group: `${plugin} · ${market}` })) out.push({ ...e, name: `${plugin}:${e.name}` });
  }
  return out;
}

const insertFor = (i) => i.type === 'agent' ? `Use the ${i.name} agent to ` : `/${i.name} `;

function scanCatalog(cwd, home) {
  const repo = scanRoot(path.join(cwd, '.claude'), { origin: 'repo', group: 'This repo' });
  const pc = scanRoot(path.join(home, '.claude'), { origin: 'pc', group: 'My PC' });
  const inRepo = new Set(repo.map(i => i.type + ':' + i.name));
  const inPc = new Set(pc.map(i => i.type + ':' + i.name));
  for (const i of pc) if (inRepo.has(i.type + ':' + i.name)) i.shadowed = 'repo';
  for (const i of repo) if (inPc.has(i.type + ':' + i.name)) i.overrides = 'pc';
  return [...repo, ...pc, ...scanPlugins(cwd, home), ...BUILTINS].map(i => ({ ...i, insert: i.insert || insertFor(i) }));
}

module.exports = { frontmatter, scanCatalog, BUILTINS };
