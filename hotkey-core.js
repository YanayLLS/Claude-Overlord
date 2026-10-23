// Shortcut matching that survives a non-Latin keyboard layout.
// Under a Hebrew (Russian, Arabic…) layout Ctrl+V arrives as key 'ו', not 'v',
// so every `e.key === 'v'` check silently misses. The physical key (e.code
// 'KeyV') still names the Latin letter, so hotkeys match it when the typed
// key isn't a Latin letter. When it is (QWERTY, Dvorak, AZERTY) the typed
// letter wins: on Dvorak the 'v' key sits at the physical position of '.'.
// Returns the lower-cased letter, or the lower-cased key for non-letter keys.
function hotkeyLetter(e) {
  const k = String(e.key ?? '');
  if (/^[a-zA-Z]$/.test(k)) return k.toLowerCase();
  const m = /^Key([A-Z])$/.exec(e.code || '');
  return m ? m[1].toLowerCase() : k.toLowerCase();
}

if (typeof module !== 'undefined' && module.exports) module.exports = { hotkeyLetter };
