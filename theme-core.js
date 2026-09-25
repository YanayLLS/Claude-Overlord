// Themes: the parts CSS can't reach. theme.css holds each theme's UI palette
// (html[data-theme]); this holds the matching terminal and Windows title-bar colors.
// Shared by the renderer and main.js. Self-check: theme-core.test.js

// ANSI palette for 16-color output; Claude itself mostly paints in truecolor.
const THEME_ANSI = {
  black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', magenta: '#cba6f7', cyan: '#94e2d5', white: '#bac2de',
  brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#cba6f7', brightCyan: '#94e2d5', brightWhite: '#a6adc8',
};

// bg/symbol: header and window-button colors. term/termFg: the terminal (Light keeps it dark).
const THEMES = {
  midnight:   { label: 'Midnight',   bg: '#0e0e10', symbol: '#9a9aa3', term: '#0e0e10', termFg: '#e4e4e7' },
  graphite:   { label: 'Graphite',   bg: '#1a1a1d', symbol: '#a1a1aa', term: '#18181b', termFg: '#ececef' },
  nord:       { label: 'Nord',       bg: '#2e3440', symbol: '#b8c0cf', term: '#2b303b', termFg: '#eceff4' },
  catppuccin: { label: 'Catppuccin', bg: '#1e1e2e', symbol: '#a6adc8', term: '#1e1e2e', termFg: '#cdd6f4' },
  light:      { label: 'Light',      bg: '#fafafa', symbol: '#52525b', term: '#18181b', termFg: '#e4e4e7' },
};

function themeOf(name) { return THEMES[name] || THEMES.midnight; }

function xtermTheme(name) {
  const t = themeOf(name);
  return { ...THEME_ANSI, background: t.term, foreground: t.termFg, cursor: t.termFg, cursorAccent: t.term, selectionBackground: '#7c8cff44' };
}

function titleBarColors(name) {
  const t = themeOf(name);
  return { color: t.bg, symbolColor: t.symbol };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { THEMES, themeOf, xtermTheme, titleBarColors };
}
