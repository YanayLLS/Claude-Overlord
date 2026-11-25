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
  // The PRs panel's buttons (main.js prActions): an agent the user asked to handle PRs.
  { name: 'pr_list', description: 'Open PRs in the repos Overlord watches, as its PRs panel lists them: checks, mergeable state, review decision, auto-merge phase, hidden state and the agent holding each. Read this first.',
    inputSchema: { type: 'object', properties: { mine: { type: 'boolean', description: 'Only the user\'s own PRs' } } } },
  { name: 'pr_auto_merge', description: 'Arm Fix & merge on PRs, as the row\'s Auto-merge: Overlord keeps each one green (sends a fix agent on red checks or conflicts, updates a branch that is behind) and merges it once green, release gate and holds included. Works on a PR you just opened with gh pr create. on false cancels.',
    inputSchema: { type: 'object', properties: { prs: { type: 'array', items: { type: 'string' }, description: 'PR urls or owner/repo#number' }, on: { type: 'boolean', description: 'Default true' } }, required: ['prs'] } },
  { name: 'pr_merge', description: 'Merge a PR now, as the row\'s Merge button (the release gate still applies). Only when the user asked you to merge.',
    inputSchema: { type: 'object', properties: { pr: str('The PR url, or owner/repo#number') }, required: ['pr'] } },
  { name: 'pr_approve', description: 'Approve a PR on GitHub as the user, as the row\'s Approve button. Only when the user asked you to approve it.',
    inputSchema: { type: 'object', properties: { pr: str('The PR url, or owner/repo#number') }, required: ['pr'] } },
  { name: 'pr_fix', description: 'Send a new agent to fix a PR\'s failing checks or conflicts, as the row\'s Fix button. If an agent already holds the PR, that one is named instead.',
    inputSchema: { type: 'object', properties: { pr: str('The PR url, or owner/repo#number') }, required: ['pr'] } },
  { name: 'pr_watch_repos', description: 'The repos whose PRs Overlord watches (its PRs panel and PR settings). Add or remove repos, or pass neither to read the list. Release repos are watched for the whole team and cannot be removed.',
    inputSchema: { type: 'object', properties: { add: { type: 'array', items: { type: 'string' }, description: 'owner/name repos to start watching' }, remove: { type: 'array', items: { type: 'string' }, description: 'owner/name repos to stop watching' } } } },
  { name: 'pr_hide', description: 'Archive, mute or snooze a PR in Overlord\'s PRs panel (GitHub is untouched). undo shows it again.',
    inputSchema: { type: 'object', properties: { pr: str('The PR url, or owner/repo#number'), how: { type: 'string', enum: ['archive', 'mute', 'snooze'] }, undo: { type: 'boolean' }, hours: { type: 'number', description: 'Snooze length, default 24' } }, required: ['pr', 'how'] } },
];
// Releases (releases-main.js agentApi): the Releases board's own buttons, for an agent the user asked to run a release.
const RELEASE_SCHEMAS = [
  { name: 'release_status', description: 'Where releases stand: the nightly release candidate (grade, headline, whether it is live, the commits it pins), the open and in-flight releases (each repo: PR, merged, signers, deploy state and run url, back-merge) and Release all progress. Read this first.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'release_open', description: 'Open the release candidate release (alpha + prod PRs pinned at the tested commits), as the card Release button button. Only when the user asked to release.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'release_sign', description: 'Sign the pending release as the user (approve its prod PRs, its alpha PRs and back-merges). It counts as the user signature: only when the user explicitly asked you to sign.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'release_all', description: 'Start or resume Release all for a release: merges wave by wave and waits for the deploys of each wave. It refuses an unsigned release, a hold or a red check.',
    inputSchema: { type: 'object', properties: { id: str('Release id, e.g. 2026-11-17-03 (from release_status). Omit for the current run.') } } },
  { name: 'release_pause', description: 'Pause prod releases for the whole team until a time (no release opens by itself, none merges, signing does not start one), or resume them (on false). Only when the user asked.',
    inputSchema: { type: 'object', properties: { on: { type: 'boolean', description: 'true pauses, false resumes' }, until: str('When the pause ends (ISO time). Default 18:00 the next day.'), note: str('Why, shown to the team') }, required: ['on'] } },
  { name: 'release_rerun_failed', description: 'Re-run every failed deploy of a release (a full re-run of each failed deploy workflow run). Then release_all with the same id picks up where it stopped once they are green.',
    inputSchema: { type: 'object', properties: { id: str('Release id') }, required: ['id'] } },
];
async function releaseCall(api, name, args = {}) {
  try {
    if (!api) return fail('Releases are unavailable.');
    if (name === 'release_status') return text(JSON.stringify(api.status(), null, 1));
    if (name === 'release_open') { await api.open(); return text('Opening the release: check release_status in a minute.'); }
    if (name === 'release_sign') { await api.sign(); return text('Signed. release_status shows the signers.'); }
    if (name === 'release_all') { api.all(args.id).catch(() => {}); return text('Release all started: follow it with release_status.'); }
    if (name === 'release_pause') { const p = await api.pause(args.on !== false, args.until, args.note); return text(p ? `Releases paused until ${p.until}.` : 'Releases resumed.'); }
    if (name === 'release_rerun_failed') { if (!args.id) return fail('release_rerun_failed: "id" is required'); return text((await api.rerunFailed(args.id)).join(String.fromCharCode(10))); }
    return fail(`Unknown tool: ${name}`);
  } catch (e) { return fail(e && e.message ? e.message : String(e)); }
}

// close_self (main.js closeSelf): the agent asks to be closed once its current turn ends.
const SELF_SCHEMAS = [
  { name: 'close_self', description: 'Close yourself (this agent) in Overlord when your current turn ends: your item leaves the agent list and your session stops (its transcript stays on disk). Call it only when the user asked you to close when done, as your last action.',
    inputSchema: { type: 'object', properties: {} } },
];

// Messaging another agent in this Overlord (main.js agentMessaging). Claude Code's own SendMessage reaches only agents
// whose Claude is running: one CPU saving put to sleep was unreachable. This wakes it and delivers.
const AGENT_SCHEMAS = [
  { name: 'agent_list', description: 'List the other agents in this Overlord by their Overlord name (the name the user calls them by, e.g. Ada), with title, folder and status (working, waiting or sleeping).',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'agent_message', description: 'Send a message to another agent in this Overlord, by its Overlord name. It arrives as a prompt from you, and an agent CPU saving put to sleep is woken for it. Use this, not SendMessage, for agents in this Overlord. Only when the user asked you to message that agent.',
    inputSchema: { type: 'object', properties: { agent: { type: 'string', description: 'The agent\'s Overlord name, e.g. Ada (agent_list shows them)' }, text: { type: 'string', description: 'The message' } }, required: ['agent', 'text'] } },
];
// Switching the Claude login (main.js agentAccounts). An agent's own /login is undone by Overlord, which owns the
// credentials file, so a chat that must act as another account (publish an artifact as it, say) asks for it here.
const ACCOUNT_SCHEMAS = [
  { name: 'account_list', description: 'The Claude logins saved in Overlord, which one is the main login, and which one you run on.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'account_use', description: 'Run only this chat on a saved Claude account (account_list shows them), e.g. to publish artifacts as that account. The main login and every other agent stay as they are. You restart on it when this turn ends and the chat resumes, so finish your reply; Overlord then tells you to continue. Use this whenever only your own work needs the account. Never use /login: Overlord undoes it.',
    inputSchema: { type: 'object', properties: { account: { type: 'string', description: 'Saved account label or email' } }, required: ['account'] } },
  { name: 'account_switch', description: 'Switch Overlord\'s main Claude login, for the whole app, to a saved account (account_list shows them). Only for app-wide reasons, such as the main login hitting its usage limit or the user asking to switch Overlord\'s account; for your own work use account_use. Every agent on the main login moves to it at its next idle moment; you restart on it when this turn ends and the chat resumes. Never use /login: Overlord undoes it.',
    inputSchema: { type: 'object', properties: { account: { type: 'string', description: 'Saved account label or email' } }, required: ['account'] } },
];
async function accountCall(accounts, agentId, name, args = {}) {
  try {
    if (!accounts) return fail('Switching accounts is unavailable.');
    if (name === 'account_list') return text(JSON.stringify(accounts.list(agentId), null, 1));
    if (name === 'account_switch' || name === 'account_use') {
      if (typeof args.account !== 'string' || !args.account.trim()) return fail(`${name}: "account" is required`);
      return text(await (name === 'account_use' ? accounts.use : accounts.switchTo)(agentId, args.account.trim()));
    }
    return fail(`Unknown tool: ${name}`);
  } catch (e) { return fail(e && e.message ? e.message : String(e)); }
}

async function agentCall(messaging, agentId, name, args = {}) {
  try {
    if (!messaging) return fail('Messaging other agents is unavailable.');
    if (name === 'agent_list') return text(JSON.stringify(messaging.list(agentId), null, 1));
    if (name === 'agent_message') {
      if (typeof args.agent !== 'string' || !args.agent.trim()) return fail('agent_message: "agent" is required');
      if (typeof args.text !== 'string' || !args.text.trim()) return fail('agent_message: "text" is required');
      return text(messaging.send(agentId, args.agent.trim().replace(/^@/, ''), args.text));
    }
    return fail(`Unknown tool: ${name}`);
  } catch (e) { return fail(e && e.message ? e.message : String(e)); }
}

async function prCall(claims, agentId, name, args = {}) {
  try {
    if (!claims) return fail('PRs are unavailable.');
    const pr = () => { if (typeof args.pr !== 'string' || !args.pr) throw new Error(`${name}: "pr" is required`); return args.pr; };
    const run = {
      pr_claim: () => claims.claim(agentId, args.pr),
      pr_release: () => claims.release(agentId, args.pr),
      pr_list: () => claims.list({ mine: args.mine === true }),
      pr_auto_merge: () => { if (!Array.isArray(args.prs) || !args.prs.length) throw new Error('pr_auto_merge: "prs" is required'); return claims.autoMerge(args.prs, args.on !== false); },
      pr_merge: () => claims.merge(pr()),
      pr_approve: () => claims.approve(pr()),
      pr_fix: () => claims.fix(pr()),
      pr_hide: () => claims.hide(pr(), args.how, args.undo === true, args.hours),
      pr_watch_repos: () => {
        const list = (k) => { const v = args[k] ?? []; if (!Array.isArray(v) || v.some((r) => typeof r !== 'string')) throw new Error(`pr_watch_repos: "${k}" must be a list of owner/name repos`); return v; };
        return claims.repos({ add: list('add'), remove: list('remove') });
      },
    }[name];
    if (!run) return fail(`Unknown tool: ${name}`);
    const r = await run();
    if (r.error) return fail(r.error);
    return text(r.text !== undefined ? r.text : JSON.stringify(r, null, 1));
  } catch (e) { return fail(e && e.message ? e.message : String(e)); }
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

module.exports = { AGENT_SCHEMAS, agentCall, TOOL_SCHEMAS, TERMINAL_SCHEMAS, VISUAL_SCHEMAS, PR_SCHEMAS, SELF_SCHEMAS, RELEASE_SCHEMAS, releaseCall, prCall, visualCall, createDispatcher, terminalCall, ACCOUNT_SCHEMAS, accountCall };
