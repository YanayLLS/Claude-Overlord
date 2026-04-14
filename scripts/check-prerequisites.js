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
  const missing = [];

  if (!hasPython()) missing.push('python');

  // Detect C++ build tools via MSBuild or cl.exe
  const hasBuildTools =
    run('where cl.exe') ||
    run('where MSBuild.exe') ||
    run('reg query "HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\Setup" /s /f "productId" 2>nul');
  if (!hasBuildTools) missing.push('buildtools');

  if (missing.length === 0) process.exit(0);

  console.log('\nnode-pty requires native build tools that are not detected on this machine.');

  const hasWinget = !!run('where winget');

  if (hasWinget) {
    console.log('Attempting to install via winget...\n');

    if (missing.includes('python')) {
      if (install('Python 3', 'winget install Python.Python.3.12 --accept-package-agreements --accept-source-agreements')) {
        console.log('  Python 3 installed.');
      } else {
        console.error('  Could not install Python. Install manually: https://www.python.org/downloads/');
      }
    }

    if (missing.includes('buildtools')) {
      if (install('Visual Studio Build Tools',
        'winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --passive --norestart" --accept-package-agreements --accept-source-agreements')) {
        console.log('  Build Tools installed.');
      } else {
        console.error('  Could not install Build Tools. Install manually:');
        console.error('  https://visualstudio.microsoft.com/visual-cpp-build-tools/');
        console.error('  Select "Desktop development with C++" workload.');
      }
    }

    console.log('\nRestart your terminal, then re-run: npm install\n');
    process.exit(1);
  }

  // No winget — print manual instructions
  console.error('\nPlease install the following, then re-run npm install:\n');
  if (missing.includes('python')) {
    console.error('  Python 3  ->  https://www.python.org/downloads/');
    console.error('                (check "Add python.exe to PATH" during install)\n');
  }
  if (missing.includes('buildtools')) {
    console.error('  C++ Build Tools  ->  https://visualstudio.microsoft.com/visual-cpp-build-tools/');
    console.error('                       Select "Desktop development with C++" workload.\n');
  }
  process.exit(1);
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
