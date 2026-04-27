#!/usr/bin/env node
const { execSync } = require('child_process');
const os = require('os');

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch {
    return null;
  }
}

function hasPython() {
  for (const cmd of ['python3 --version', 'python --version', 'py -3 --version']) {
    const result = run(cmd);
    if (result && result.includes('Python 3')) return true;
  }
  return false;
}

function install(label, cmd) {
  console.log(`  Installing ${label}...`);
  try {
    execSync(cmd, { stdio: 'inherit' });
    return true;
  } catch {
    return false;
  }
}

// ── Windows ──────────────────────────────────────────────
if (os.platform() === 'win32') {
  if (!hasPython()) {
    console.log('\nnode-pty requires Python 3 for some build scenarios.');
    const hasWinget = !!run('where winget');
    if (hasWinget) {
      console.log('Installing Python 3 via winget...');
      install('Python 3', 'winget install Python.Python.3.12 --accept-package-agreements --accept-source-agreements');
    } else {
      console.error('Install Python 3 from https://www.python.org/downloads/');
      console.error('Check "Add python.exe to PATH" during install.');
    }
  }
  process.exit(0);
}

// ── macOS ────────────────────────────────────────────────
if (os.platform() === 'darwin') {
  if (!run('xcode-select -p')) {
    console.log('\nXcode Command Line Tools not found. Installing...\n');
    try {
      execSync('xcode-select --install', { stdio: 'inherit' });
      console.log('Follow the dialog to complete installation, then re-run: npm install\n');
    } catch {
      console.error('Run manually: xcode-select --install');
    }
    process.exit(1);
  }
}

// ── Linux ────────────────────────────────────────────────
if (os.platform() === 'linux') {
  const missingLinux = [];
  if (!run('which make')) missingLinux.push('make');
  if (!run('which g++') && !run('which gcc')) missingLinux.push('g++');
  if (!hasPython()) missingLinux.push('python3');

  if (missingLinux.length > 0) {
    console.error(`\nMissing build tools: ${missingLinux.join(', ')}`);
    console.error('Install them with your package manager, e.g.:');
    console.error('  sudo apt install build-essential python3');
    console.error('Then re-run: npm install\n');
    process.exit(1);
  }
}
