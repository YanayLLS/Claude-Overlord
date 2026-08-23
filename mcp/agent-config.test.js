const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { agentConfigDir, writeAgentConfig, writeAgentSettings, settingsFlags, removeAgentConfig } = require('./agent-config');

test('config dir is namespaced under tmpdir by agent id', () => {
  assert.strictEqual(agentConfigDir(7), path.join(os.tmpdir(), 'overlord', 'agent-7'));
});

test('writes an mcp config pointing at the token URL', () => {
  const { mcpPath } = writeAgentConfig({ id: 101, port: 5555, token: 'tok-abc' });
  const cfg = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
  assert.deepStrictEqual(cfg.mcpServers['overlord-browser'], {
    type: 'http',
    url: 'http://127.0.0.1:5555/mcp/tok-abc',
  });
  removeAgentConfig(101);
});

test('writes a settings file denying claude-in-chrome', () => {
  const { settingsPath } = writeAgentConfig({ id: 102, port: 1, token: 't' });
  const cfg = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.deepStrictEqual(cfg.permissions.deny, ['mcp__claude-in-chrome']);
  removeAgentConfig(102);
});

test('flags reference both files and are quoted', () => {
  const { flags, mcpPath, settingsPath } = writeAgentConfig({ id: 103, port: 1, token: 't' });
  assert.strictEqual(flags, ` --mcp-config "${mcpPath}" --settings "${settingsPath}"`);
  removeAgentConfig(103);
});

test('removeAgentConfig deletes the directory', () => {
  writeAgentConfig({ id: 104, port: 1, token: 't' });
  removeAgentConfig(104);
  assert.strictEqual(fs.existsSync(agentConfigDir(104)), false);
});

test('removeAgentConfig on a missing directory does not throw', () => {
  assert.doesNotThrow(() => removeAgentConfig(999999));
});

// The before-quit spawn site outlives the MCP server's port, so it cannot take
// --mcp-config — but without --settings the surviving agent is free to reach
// for mcp__claude-in-chrome and drive a browser on another machine.
test('settingsFlags yields a settings-only flag for spawn sites with no browser', () => {
  const flags = settingsFlags(105);
  assert.strictEqual(flags, ` --settings "${path.join(agentConfigDir(105), 'settings.json')}"`);
  assert.doesNotMatch(flags, /--mcp-config/);
  removeAgentConfig(105);
});

test('settingsFlags writes a file that actually denies claude-in-chrome', () => {
  settingsFlags(106);
  const cfg = JSON.parse(fs.readFileSync(path.join(agentConfigDir(106), 'settings.json'), 'utf8'));
  assert.deepStrictEqual(cfg.permissions.deny, ['mcp__claude-in-chrome']);
  removeAgentConfig(106);
});

test('the settings file the browser path writes is the same one settingsFlags points at', () => {
  const { settingsPath } = writeAgentConfig({ id: 107, port: 1, token: 't' });
  assert.strictEqual(settingsPath, writeAgentSettings(107));
  removeAgentConfig(107);
});

// The token in .mcp.json is a bearer credential for this agent's browser, and
// os.tmpdir() is shared by every agent on the machine.
test('the config directory is not left world-readable', { skip: process.platform === 'win32' ? 'POSIX modes only' : false }, () => {
  writeAgentConfig({ id: 108, port: 1, token: 't' });
  assert.strictEqual(fs.statSync(agentConfigDir(108)).mode & 0o777, 0o700);
  removeAgentConfig(108);
});
