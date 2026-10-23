// Windows: switch the keyboard layout to English when Overlord gets focus.
// Electron has no API for the input language, so a tiny helper posts
// WM_INPUTLANGCHANGEREQUEST to Overlord's window with an English HKL — the
// first installed English layout (en-US, en-GB…), or en-US loaded on demand.
// The helper is compiled once from KBD_SRC with the inbox .NET Framework csc.exe
// (~1 s, in the background at startup); each focus then runs it in ~30 ms.
// Without csc the same source runs through PowerShell's Add-Type (slower).
const crypto = require('crypto');
const path = require('path');

const KBD_SRC = `using System;
using System.Runtime.InteropServices;
public static class KbdEn {
  [DllImport("user32.dll")] static extern int GetKeyboardLayoutList(int n, IntPtr[] list);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr LoadKeyboardLayout(string id, uint flags);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  const uint WM_INPUTLANGCHANGEREQUEST = 0x0050;
  public static int Main(string[] args) {
    if (args.Length < 1) return 3;
    IntPtr hwnd = (IntPtr)long.Parse(args[0]);
    IntPtr hkl = IntPtr.Zero;
    int n = GetKeyboardLayoutList(0, null);
    IntPtr[] list = new IntPtr[n];
    GetKeyboardLayoutList(n, list);
    foreach (IntPtr k in list) if (((long)k & 0x3ff) == 0x09) { hkl = k; break; } // primary language id 0x09 = English
    if (hkl == IntPtr.Zero) hkl = LoadKeyboardLayout("00000409", 0);
    if (hkl == IntPtr.Zero) return 2;
    return PostMessage(hwnd, WM_INPUTLANGCHANGEREQUEST, IntPtr.Zero, hkl) ? 0 : 1;
  }
}
`;

// Window handle from Electron's getNativeWindowHandle() Buffer, as a decimal string for the helper's argv.
function hwndOf(buf) {
  return buf.length >= 8 ? buf.readBigUInt64LE(0).toString() : String(buf.readUInt32LE(0));
}

// The inbox C# compiler (.NET Framework 4.x ships with Windows 10/11); null when absent.
function cscPath(windir, exists) {
  for (const arch of ['Framework64', 'Framework']) {
    const p = path.join(windir, 'Microsoft.NET', arch, 'v4.0.30319', 'csc.exe');
    if (exists(p)) return p;
  }
  return null;
}

// Helper file name carries the source hash: an edit to KBD_SRC rebuilds, an unchanged one is reused.
function kbdExeName() {
  return 'kbd-en-' + crypto.createHash('sha1').update(KBD_SRC).digest('hex').slice(0, 8) + '.exe';
}

// PowerShell fallback: compile in-process with Add-Type and call Main. ~1 s per run.
function kbdPowershell(hwnd) {
  const src = KBD_SRC.replace(/'/g, "''");
  return `Add-Type -TypeDefinition '${src}' | Out-Null; exit [KbdEn]::Main(@('${hwnd}'))`;
}

module.exports = { KBD_SRC, hwndOf, cscPath, kbdExeName, kbdPowershell };
