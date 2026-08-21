#!/usr/bin/env node
// Manual escape hatch for rebuilding overlord-state.json from Claude's transcripts.
// Overlord does this by itself when it finds the state file damaged (see loadState),
// so this is only for the cases it can't detect: a state file that parses fine but
// lost entries, or a deliberate re-import over a wider window.
//
// Usage:  node scripts/recover-state.js [days]     (default 2)
// Close Overlord first — it rewrites the state file on exit.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanSessions, mergeRecovered } = require('../recover-core');

const DAYS = Number(process.argv[2] || 2);
const STATE_DIR = process.env.OVERLORD_STATE_DIR || path.join(os.homedir(), '.pixel-agents');
const STATE_FILE = path.join(STATE_DIR, 'overlord-state.json');

let state = { agents: [], settings: {} };
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')); } catch {}

const added = mergeRecovered(state, scanSessions(path.join(os.homedir(), '.claude', 'projects'), DAYS));

fs.mkdirSync(STATE_DIR, { recursive: true });
if (fs.existsSync(STATE_FILE)) fs.copyFileSync(STATE_FILE, STATE_FILE + '.pre-recover');
const fd = fs.openSync(STATE_FILE, 'w');
try { fs.writeFileSync(fd, JSON.stringify(state, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }

console.log(`Recovered ${added} session(s) from the last ${DAYS} day(s); state now has ${state.agents.length} agents across ${state.settings.knownProjects.length} projects.`);
console.log(`Old state kept at ${STATE_FILE}.pre-recover`);
