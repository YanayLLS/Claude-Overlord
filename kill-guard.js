// Makes Overlord's processes immune to agents' `taskkill /F` / `Stop-Process`: a deny-TERMINATE
// ACE is added to each one's DACL, so an outside kill gets "Access is denied". Overlord's own
// exits are unaffected (a process may always end itself, and Electron kills its children through
// the handles it got at launch). An agent tree-killing a dev server twice took the whole app down
// on 2026-10-08; this is why. Escape hatch for a hung app: taskkill from an elevated prompt.
const { execFile } = require('child_process');

const LAUNCHERS = /^(cmd|node|electron|overlord|conhost)\.exe$/i;

// What to guard, from a process table [{ pid, ppid, name, created, cmd }]: this process, its launch
// chain (start.bat's cmd → npm → electron cli) with each one's conhost — killing the console Overlord
// is attached to ends it with 0xC000013A — and the pty host, which holds every agent's terminal.
function guardedPids(procs, selfPid) {
  const byPid = new Map(procs.map(p => [p.pid, p]));
  const out = new Set();
  for (let cur = byPid.get(selfPid); cur && LAUNCHERS.test(cur.name) && !out.has(cur.pid);) {
    out.add(cur.pid);
    for (const c of procs) if (c.ppid === cur.pid && /^conhost\.exe$/i.test(c.name)) out.add(c.pid);
    const parent = byPid.get(cur.ppid);
    if (parent && parent.created > cur.created) break; // PID reused: born after its "child"
    cur = parent;
  }
  for (const p of procs) if (/pty-host\.js/i.test(p.cmd || '')) out.add(p.pid);
  return [...out];
}

const ps = (script, cb) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
  { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, cb);

const LIST = `Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; created = $_.CreationDate.Ticks; cmd = $_.CommandLine } } | ConvertTo-Json -Compress`;

const PROTECT = `Add-Type @'
using System; using System.Runtime.InteropServices; using System.Security.AccessControl; using System.Security.Principal;
public static class KillGuard {
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("advapi32.dll")] static extern bool GetKernelObjectSecurity(IntPtr h, uint info, byte[] sd, uint len, out uint need);
  [DllImport("advapi32.dll")] static extern bool SetKernelObjectSecurity(IntPtr h, uint info, byte[] sd);
  public static bool Protect(int pid) {
    IntPtr h = OpenProcess(0x60000, false, pid); // READ_CONTROL | WRITE_DAC
    if (h == IntPtr.Zero) return false;
    try {
      uint need; GetKernelObjectSecurity(h, 4, null, 0, out need);
      var buf = new byte[need];
      if (!GetKernelObjectSecurity(h, 4, buf, need, out need)) return false;
      var sd = new RawSecurityDescriptor(buf, 0);
      if (sd.DiscretionaryAcl == null) return false;
      var everyone = new SecurityIdentifier(WellKnownSidType.WorldSid, null);
      foreach (GenericAce a in sd.DiscretionaryAcl) { var c = a as CommonAce; if (c != null && c.AceQualifier == AceQualifier.AccessDenied && c.SecurityIdentifier == everyone && (c.AccessMask & 1) != 0) return true; }
      sd.DiscretionaryAcl.InsertAce(0, new CommonAce(AceFlags.None, AceQualifier.AccessDenied, 1, everyone, false, null));
      var outb = new byte[sd.BinaryLength]; sd.GetBinaryForm(outb, 0);
      return SetKernelObjectSecurity(h, 4, outb);
    } finally { CloseHandle(h); }
  }
}
'@
`;

const protectPids = (pids, cb) => ps(PROTECT + pids.map(p => `[KillGuard]::Protect(${p | 0})`).join('\n'), cb);

// Guards the launch chain + pty host now, then any new Electron child (a browser pane's renderer)
// as it appears. getChildPids returns the app's own process ids (app.getAppMetrics()).
function startKillGuard({ getChildPids, log = () => {}, everyMs = 60000 }) {
  if (process.platform !== 'win32' || process.env.OVERLORD_NO_KILL_GUARD) return;
  const done = new Set();
  const protect = (pids) => {
    const fresh = pids.filter(p => p > 0 && !done.has(p));
    if (!fresh.length) return;
    fresh.forEach(p => done.add(p));
    ps(PROTECT + fresh.map(p => `[void][KillGuard]::Protect(${p | 0})`).join('\n'), (e) => e && log(`kill guard failed: ${e.message}`));
  };
  ps(LIST, (e, out) => {
    if (e) return log(`kill guard: process list failed: ${e.message}`);
    try { protect([...guardedPids(JSON.parse(out), process.pid), ...getChildPids()]); } catch (err) { log(`kill guard: ${err.message}`); }
  });
  setInterval(() => protect(getChildPids()), everyMs).unref();
}

module.exports = { guardedPids, protectPids, startKillGuard };
