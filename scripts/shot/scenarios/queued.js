// Queued messages in the Chat view: each has Send now, Edit and Remove.
//   npx electron scripts/shot/run.js scripts/shot/scenarios/queued.js <outDir>
module.exports = async ({ inject, js, shot, wait }) => {
  await inject({ type: 'settings', settings: { knownProjects: ['C:/Work/overlord'], projects: {} } });
  const now = Date.now();
  await inject({ type: 'agentCreated', id: 1, cwd: 'C:/Work/overlord', sessionId: 's1', title: 'Queue demo', customName: true, agentName: 'Raven', createdAt: now - 60000 });
  await inject({ type: 'status', id: 1, status: 'active' });
  await js(`focusAgent(1); switchTermTab('conversation'); true`);
  await inject({ type: 'timelineData', id: 1, events: [
    { type: 'prompt', text: 'Fix the login bug', ts: new Date(now - 50000).toISOString() },
    { type: 'text', text: 'Looking at the auth flow now.', ts: new Date(now - 40000).toISOString() },
    { type: 'queue', op: 'enqueue', text: 'also check the signup page', ts: new Date(now - 30000).toISOString() },
  ] });
  await js(`chatUi.addPending(1, 'and run the tests after'); const p = chatUi; renderConversation(); true`);
  await js(`(window.__p = true); true`);
  await wait(500);
  await shot('queued');
  await js(`document.querySelectorAll('#conversation .msg.user.pending').forEach(m => m.classList.add('hover')); document.querySelector('#conversation .cliq .q-now')?.focus(); true`);
  await shot('queued-focus');
  console.log(await js(`document.querySelector(".tail")?.outerHTML.slice(0, 2500) || 'no queue'`));
};
