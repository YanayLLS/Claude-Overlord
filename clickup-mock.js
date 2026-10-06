// A fake ClickUp for demos and tests: `electron . --mock-clickup` makes every ClickUp request answer from here,
// with no network and no token. Tickets, comments and statuses live in memory; replies and status changes
// mutate them, so the Quest Log behaves exactly as it does against the real thing.
'use strict';

const PIC = (seed, w = 1200, h = 800) => `https://picsum.photos/seed/${seed}/${w}/${h}`;
const THUMB = (seed) => `https://picsum.photos/seed/${seed}/320/200`;
const VIDEO = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';
const now = Date.now();
const ago = (min) => String(now - min * 60000);

const people = {
  qa: { id: '90010001', username: 'Dana QA', color: '#f38ba8', profilePicture: '' },
  pm: { id: '90010002', username: 'Yoni PM', color: '#89b4fa', profilePicture: '' },
};
let me = { id: '0', username: 'you', color: '#a6e3a1', profilePicture: '' };

const board = { id: '901100100', name: 'Frontline One' };
const platformField = { id: 'cf_platform', name: 'Platform', type: 'drop_down', type_config: { options: [{ id: 'p-web', label: 'Webapp' }, { id: 'p-ios', label: 'iOS' }, { id: 'p-and', label: 'Android' }, { id: 'p-api', label: 'API' }] } };
const statuses = [
  { status: 'to do', color: '#87909e', type: 'open', orderindex: 0 },
  { status: 'in development', color: '#4194f6', type: 'custom', orderindex: 1 },
  { status: 'failed qa', color: '#e0383e', type: 'custom', orderindex: 2 },
  { status: 'waiting for merge', color: '#f9d342', type: 'custom', orderindex: 3 },
  { status: 'passed qa', color: '#2ecd6f', type: 'custom', orderindex: 4 },
  { status: 'released', color: '#6a5acd', type: 'closed', orderindex: 5 },
];

const md = (title, steps, extra = '') => `## Report details

- **Reporter:** Dana QA
- **Page:** ${title}
- **Context:** [Open the reported page](https://example.com/page)

## Steps to reproduce

${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}

## Expected

It works.

## Actual

It does not. See the recording below.
${extra}`;

const mkTask = (n, name, priority, platform, status, body, attachments, created) => ({
  id: 'mock' + n, name, url: 'https://app.clickup.com/t/mock' + n, status: { status },
  priority: priority ? { priority } : null,
  custom_fields: [{ ...platformField, value: platform ? [platform] : null }],
  assignees: [], list: board, tags: [{ name: 'customer' }, ...(n % 3 === 0 ? [{ name: 'regression' }] : [])],
  date_created: ago(created), date_updated: ago(created / 2), due_date: String(now + 3 * 86400000),
  markdown_description: body, attachments,
});
const att = (n, i, title, kind) => kind === 'video'
  ? { id: `a${n}-${i}`, title, url: VIDEO, mimetype: 'video/mp4', extension: 'mp4', size: 3200000, thumbnail_medium: '' }
  : { id: `a${n}-${i}`, title, url: PIC(`m${n}-${i}`), thumbnail_medium: THUMB(`m${n}-${i}`), mimetype: kind === 'png' ? 'image/png' : 'image/jpeg', extension: kind, size: 240000 + i * 1000 };

const tasks = new Map([
  mkTask(1, 'Checkout | Pay button does nothing on second attempt', 'urgent', 'p-web', 'failed qa',
    md('Checkout', ['Add any item to the cart.', 'Pay once and cancel in the bank page.', 'Press Pay again.'], `\n![The dead button](${PIC('m1-inline')})\n`),
    [att(1, 1, 'checkout-before.png', 'png'), att(1, 2, 'checkout-after.jpg', 'jpg'), att(1, 3, 'checkout-recording.mp4', 'video')], 42),
  mkTask(2, 'Login | Session drops after app resumes from background', 'urgent', 'p-ios', 'failed qa',
    md('Login', ['Sign in on the iPad.', 'Leave the app for ten minutes.', 'Come back: you are signed out.']), [att(2, 1, 'resume-crash.png', 'png')], 300),
  mkTask(3, 'Flow Player | Render error on the sales demo', 'high', 'p-web', 'failed qa',
    md('Flow Player', ['Open the multiFiltratePRO demo.', 'Start the flow.', 'A red error appears at step 3.'], `\n<img src="${PIC('m3-inline')}">\n`), [att(3, 1, 'render-error.jpg', 'jpg'), att(3, 2, 'console.png', 'png')], 120),
  mkTask(4, 'AR Placement | Objects drift after QR scanning', 'high', 'p-and', 'failed qa',
    md('AR Placement', ['Scan the QR on the device.', 'Place the model.', 'Walk two metres: the model slides.']), [att(4, 1, 'drift.mp4', 'video')], 95),
  mkTask(5, 'Knowledge Base | Search ignores the second word', 'high', 'p-web', 'in development',
    md('Knowledge Base', ['Search for "filter housing".', 'Only "filter" results come back.']), [], 60),
  mkTask(6, 'Native App | Header overlaps the status bar in landscape', 'normal', 'p-ios', 'failed qa',
    md('Native App', ['Rotate the iPad.', 'The header hides under the clock.']), [att(6, 1, 'landscape.png', 'png'), att(6, 2, 'portrait.png', 'png'), att(6, 3, 'closeup.heic', 'heic')], 1500),
  mkTask(7, 'Guides | Step counter shows 0 of 0 on reopen', 'normal', 'p-web', 'failed qa',
    md('Guides', ['Open a guide.', 'Close and reopen it.', 'The counter reads 0 of 0.']), [], 2000),
  mkTask(8, 'API | Export endpoint returns 500 for empty projects', 'normal', 'p-api', 'in development',
    md('API', ['Create an empty project.', 'Call /export.', 'HTTP 500.']), [], 700),
  mkTask(9, 'Flow Viewer | Tooltip text is cut off on small screens', 'low', 'p-and', 'failed qa',
    md('Flow Viewer', ['Open any flow on a phone.', 'Hover a node.']), [att(9, 1, 'tooltip.jpg', 'jpg')], 4000),
  mkTask(10, 'Settings | Dark mode toggle needs two clicks', 'low', 'p-web', 'failed qa',
    md('Settings', ['Open settings.', 'Toggle dark mode: nothing.', 'Toggle again: it switches.']), [], 5200),
  mkTask(11, 'Reports | PDF export loses the chart legend', null, 'p-web', 'failed qa',
    md('Reports', ['Open a report with a chart.', 'Export to PDF.', 'No legend.']), [att(11, 1, 'legend-missing.png', 'png')], 800),
].map(t => [t.id, t]));

let cid = 100;
const text = (t, attributes) => ({ text: t, attributes: attributes || {} });
const mkComment = (user, blocks, minAgo, replies = []) => ({ id: String(++cid), comment: blocks, comment_text: blocks.map(b => b.text || (b.attachment ? '[' + b.attachment.title + ']' : '')).join(''), user, date: ago(minAgo), reply_count: replies.length, resolved: false, _replies: replies });
const comments = new Map();
comments.set('mock1', [
  mkComment(people.qa, [text('Reproduced on Chrome and Safari. The second request never leaves the browser, see '), text('network tab', { link: 'https://example.com/har', bold: true }), text('.')], 40, [
    mkComment(people.pm, [{ type: 'tag', text: '@Dana QA' }, text(' is this also on the native app?')], 30),
    mkComment(people.qa, [text('No, native is fine. Web only.')], 25),
  ]),
  mkComment(people.pm, [text('Blocking the release. '), { type: 'attachment', attachment: { id: 'c1', title: 'network.png', url: PIC('c1-net'), thumbnail_medium: THUMB('c1-net'), mimetype: 'image/png', extension: 'png' } }], 20),
]);
comments.set('mock3', [mkComment(people.qa, [text('Happens only with the '), text('fresenius-clone', { code: true }), text(' workspace.')], 100)]);
comments.set('mock6', [mkComment(people.pm, [text('Low effort, nice to have before the demo.')], 900)]);

function json(body, status = 200) { return Promise.resolve({ json: body, status }); }

function request(method, path, body, user) {
  if (user && user.id) me = { id: String(user.id), username: user.username || 'you', color: '#a6e3a1', profilePicture: '' };
  const p = path.split('?')[0];
  let m;
  if (p === '/user') return json({ user: { id: me.id, username: me.username, email: 'you@example.com' } });
  if (p === '/team') return json({ teams: [{ id: '9000000001', name: 'Mock workspace' }] });
  if (/^\/team\/[^/]+\/space$/.test(p)) return json({ spaces: [{ id: '90100', name: 'Product' }] });
  if (/^\/space\/[^/]+\/folder$/.test(p)) return json({ folders: [] });
  if (/^\/space\/[^/]+\/list$/.test(p)) return json({ lists: [board] });
  if (/^\/team\/[^/]+\/task$/.test(p)) return json({ tasks: [...tasks.values()].map(t => ({ ...t, assignees: [{ id: me.id, username: me.username }] })), last_page: true });
  if ((m = p.match(/^\/task\/([^/]+)$/))) {
    const t = tasks.get(m[1]); if (!t) return json({ err: 'Task not found' }, 404);
    if (method === 'PUT' && body && body.status) t.status = { status: String(body.status) };
    return json({ ...t, assignees: [{ id: me.id, username: me.username }] });
  }
  if ((m = p.match(/^\/task\/([^/]+)\/comment$/))) {
    const list = comments.get(m[1]) || (comments.set(m[1], []), comments.get(m[1]));
    if (method === 'POST') { list.push(mkComment(me, [text(String(body && body.comment_text || ''))], 0)); return json({ id: String(cid) }); }
    return json({ comments: list.map(c => ({ ...c, reply_count: c._replies.length })) });
  }
  if ((m = p.match(/^\/comment\/([^/]+)\/reply$/))) {
    const parent = [...comments.values()].flat().find(c => c.id === m[1]);
    if (!parent) return json({ err: 'Comment not found' }, 404);
    if (method === 'POST') { parent._replies.push(mkComment(me, [text(String(body && body.comment_text || ''))], 0)); return json({ id: String(cid) }); }
    return json({ comments: parent._replies });
  }
  if (/^\/list\/[^/]+$/.test(p)) return json({ ...board, statuses });
  return json({ err: 'mock: no route for ' + method + ' ' + path }, 404);
}

module.exports = { request, board };
