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
  { name: 'browser_eval', description: 'Evaluate a JavaScript expression in the page and return the JSON-serialized result.',
    inputSchema: { type: 'object', properties: { js: str('A JavaScript expression') }, required: ['js'] } },
];

const text = (t) => ({ content: [{ type: 'text', text: String(t) }] });
const fail = (t) => ({ content: [{ type: 'text', text: String(t) }], isError: true });

const HANDLERS = {
  browser_navigate: (a, g) => a.navigate(g('url')),
  browser_snapshot: (a) => a.snapshot(),
  browser_click: (a, g) => a.click(g('ref')),
  browser_type: (a, g, args) => a.type(g('ref'), g('text'), args.submit === true),
  browser_console: (a) => a.consoleErrors(),
  browser_eval: (a, g) => a.evaluate(g('js')),
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

module.exports = { TOOL_SCHEMAS, createDispatcher };
