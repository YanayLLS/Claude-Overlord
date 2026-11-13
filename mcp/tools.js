// MCP tool schemas + dispatch onto an actions object. No Electron, no HTTP.
const str = (description) => ({ type: 'string', description });

const TOOL_SCHEMAS = [
  { name: 'browser_navigate', description: 'Load a URL in this agent\'s own browser. Returns the final URL after redirects.',
    inputSchema: { type: 'object', properties: { url: str('Absolute http(s) URL') }, required: ['url'] } },
  { name: 'browser_snapshot', description: 'List the page\'s interactive elements with ref_N handles. Use this before clicking or typing — it is far cheaper than a screenshot.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_screenshot', description: 'Capture a PNG of the current page. Use browser_snapshot instead unless you need to judge visual appearance.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_click', description: 'Click the element with the given ref from the last browser_snapshot.',
    inputSchema: { type: 'object', properties: { ref: str('A ref_N handle from browser_snapshot') }, required: ['ref'] } },
  { name: 'browser_type', description: 'Focus the element with the given ref and type text into it.',
    inputSchema: { type: 'object', properties: { ref: str('A ref_N handle from browser_snapshot'), text: str('Text to type'), submit: { type: 'boolean', description: 'Press Enter afterwards' } }, required: ['ref', 'text'] } },
  { name: 'browser_console', description: 'Read buffered console warnings, console errors, failed loads and failed network requests for this page.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_viewport', description: 'Set the width (and optionally height) the page lays out at, e.g. 1440 for the desktop layout or 390 for a phone, whatever size the user\'s pane is: it is drawn scaled to fit. Use it instead of asking the user to resize the pane or the window. width 0 goes back to the pane\'s own size.',
    inputSchema: { type: 'object', properties: { width: { type: 'number', description: 'Layout width in CSS px (320-3840), 0 to reset' }, height: { type: 'number', description: 'Layout height in CSS px; omit to fill the pane' } }, required: ['width'] } },
  { name: 'browser_close', description: 'Close your browser pane beside the chat when you are done with the page (a test or check finished). The next browser_navigate opens it again; logins are kept.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_eval', description: 'Evaluate a JavaScript expression in the page and return the JSON-serialized result.',
    inputSchema: { type: 'object', properties: { js: str('A JavaScript expression') }, required: ['js'] } },
];

// The Terminals pane's tabs (term-pane.js): shared by every agent, not per-agent like the browser.
const TERMINAL_SCHEMAS = [
  { name: 'terminal_list', description: 'List the dev-server terminals in the Terminals pane of Overlord (tabs opened by scripts like start-full.bat): name, running or exit code, folder, command.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'terminal_read', description: 'Read what a Terminals-pane terminal printed (plain text, colours stripped). Use it to debug a local server: its errors, stack traces, request logs.',
    inputSchema: { type: 'object', properties: { name: str('Terminal name from terminal_list, e.g. "FL Backend (S3-wired)"'), lines: { type: 'number', description: 'Last N lines (default 200, max 5000)' }, grep: str('Only lines matching this regex (case-insensitive)') }, required: ['name'] } },
  { name: 'terminal_restart', description: 'Restart a Terminals-pane terminal: kill its process and run its command again (e.g. a backend that does not hot-reload).',
    inputSchema: { type: 'object', properties: { name: str('Terminal name from terminal_list') }, required: ['name'] } },
];

// A visual drawn inline in the agent's chat (chat-ui.js renders the call itself): nothing to do here but answer.
const VISUAL_SCHEMAS = [
  { name: 'show_visual', description: 'Show a visual inline in the user\'s chat: a UI mockup, diagram, chart, table or comparison drawn as self-contained HTML/SVG (inline CSS and JS only; no network, so no external fonts, images or scripts; data: URIs are fine). It renders live in a sandboxed frame as wide as the chat column, sized to its content. Pass variants to let the user flip between alternatives (e.g. "Dense" / "Roomy" / "With icons"). The frame predefines CSS variables matching the chat theme: --bg, --fg, --muted, --surface, --border, --accent, --font.',
    inputSchema: { type: 'object', properties: {
      title: str('Short title shown above the visual'),
      html: str('Self-contained HTML/SVG (body content or a whole document). Use this or variants'),
      variants: { type: 'array', description: 'Alternatives the user flips between with tabs', items: { type: 'object', properties: { label: str('Tab label, 1-3 words'), html: str('Self-contained HTML/SVG') }, required: ['label', 'html'] } },
    } } },
];

// PR claims (main.js prClaimFor): one agent per pull request, so auto-merge or the Fix button never sends a second one.
const PR_SCHEMAS = [
  { name: 'pr_claim', description: 'Tell Overlord you are working on a GitHub pull request (fixing its checks or conflicts, updating its branch, getting it merged), so it never sends a second agent to the same PR. Call it before you start. If another agent already holds the PR you are told which: leave the PR to it. The claim lasts until you call pr_release or your session is closed, and survives Overlord restarting.',
    inputSchema: { type: 'object', properties: { pr: str('The PR url, or owner/repo#number') }, required: ['pr'] } },
  { name: 'pr_release', description: 'Hand back a PR you claimed with pr_claim, once it is merged or you stop working on it, so Overlord can send another agent if it goes red again.',
    inputSchema: { type: 'object', properties: { pr: str('The PR url, or owner/repo#number') }, required: ['pr'] } },
];
function prCall(claims, agentId, name, args = {}) {
  if (!claims) return fail('PR claims are unavailable.');
  const r = (name === 'pr_claim' ? claims.claim : claims.release)(agentId, args.pr);
  return r.error ? fail(r.error) : text(r.text);
}

function visualCall(args = {}) {
  const ok = (h) => typeof h === 'string' && h.trim() !== '';
  const vs = Array.isArray(args.variants) ? args.variants.filter((v) => v && ok(v.html)) : [];
  if (vs.length) return text(`Shown in the chat${vs.length > 1 ? ` (${vs.length} variants)` : ''}.`);
  if (ok(args.html)) return text('Shown in the chat.');
  return fail('show_visual: pass "html" or "variants" (each with label and html)');
}

const text = (t) => ({ content: [{ type: 'text', text: String(t) }] });
const fail = (t) => ({ content: [{ type: 'text', text: String(t) }], isError: true });

const HANDLERS = {
  browser_navigate: (a, g) => a.navigate(g('url')),
  browser_snapshot: (a) => a.snapshot(),
  browser_click: (a, g) => a.click(g('ref')),
  browser_type: (a, g, args) => a.type(g('ref'), g('text'), args.submit === true),
  browser_console: (a) => a.consoleErrors(),
  browser_eval: (a, g) => a.evaluate(g('js')),
  browser_viewport: (a, _g, args) => a.viewport(args.width, args.height),
  browser_close: (a) => a.close(),
};

function requiredGetter(args, name) {
  return (key) => {
    const v = args[key];
    if (typeof v !== 'string' || v === '') throw new Error(`${name}: "${key}" is required and must be a non-empty string`);
    return v;
  };
}

function createDispatcher(actions) {
  return async function call(name, args = {}) {
    try {
      if (name === 'browser_screenshot') {
        return { content: [{ type: 'image', data: await actions.screenshot(), mimeType: 'image/png' }] };
      }
      const handler = HANDLERS[name];
      if (!handler) return fail(`Unknown tool: ${name}`);
      return text(await handler(actions, requiredGetter(args, name), args));
    } catch (e) {
      return fail(e && e.message ? e.message : String(e));
    }
  };
}

function terminalCall(terminals, name, args = {}) {
  try {
    if (!terminals) return fail('The Terminals pane is not running.');
    if (name === 'terminal_list') return text(terminals.list());
    const g = requiredGetter(args, name);
    if (name === 'terminal_read') return text(terminals.read(g('name'), { lines: Number(args.lines) || 200, grep: typeof args.grep === 'string' && args.grep ? args.grep : undefined }));
    if (name === 'terminal_restart') return text(terminals.restart(g('name')));
    return fail(`Unknown tool: ${name}`);
  } catch (e) { return fail(e && e.message ? e.message : String(e)); }
}

module.exports = { TOOL_SCHEMAS, TERMINAL_SCHEMAS, VISUAL_SCHEMAS, PR_SCHEMAS, prCall, visualCall, createDispatcher, terminalCall };
