// The agent list with a feature, a plain project and agents in every state.
//   npx electron scripts/shot/run.js scripts/shot/scenarios/list.js <outDir>
module.exports = async ({ inject, js, shot, wait }) => {
  const W = 'C:/Users/me/.overlord/worktrees';
  await inject({ type: 'settings', settings: {
    knownProjects: ['C:/Work/overlord', 'C:/Work/Designs'],
    worktrees: [
      { path: `${W}/Designs/Model-update`, repo: 'C:/Work/Designs', branch: 'Model-update', base: 'dev', port: 5180, status: 'ready', feature: 'Model update' },
      { path: `${W}/frontline.io-web/Model-update`, repo: 'C:/Work/frontline.io-web', branch: 'Model-update', base: 'dev', port: 5170, status: 'failed', setupError: 'Needs Node 22', feature: 'Model update' },
    ],
    projects: {},
  } });
  const now = Date.now(), H = 3600000;
  const agents = [
    [1, 'C:/Work/overlord', 'Raven', 'Feature UI styling', 'active'],
    [2, 'C:/Work/overlord', 'Briar', 'Fix PR list sort', 'waiting'],
    [3, 'C:/Work/Designs', 'Falcon', 'Flow editor side menu', 'waiting'],
    [4, 'C:/Work/Designs', 'Wren', 'Immersive room bottom bar', 'idle'],
    [5, 'C:/Work/Designs', 'Moss', 'Animations panel hover', 'idle'],
    [6, `${W}/Designs/Model-update`, 'Ash', 'ClickUp task 25595975', 'active'],
    [7, `${W}/frontline.io-web/Model-update`, 'Pike', 'Model update backend', 'waiting'],
  ];
  for (const [id, cwd, agentName, title, status] of agents) {
    await inject({ type: 'agentCreated', id, cwd, sessionId: 's' + id, title, customName: true, agentName, createdAt: now - id * H });
    await inject({ type: 'status', id, status });
  }
  await inject({ type: 'perm', id: 3, ask: false });
  await inject({ type: 'perm', id: 7, ask: true });
  await inject({ type: 'wtServer', path: `${W}/Designs/Model-update`, running: true, port: 5180, url: 'https://lvh.me:5180' });
  await wait(600);
  await shot('list');
  // Agents idle for hours fold into "+N quiet"; the row opens them.
  await js(`for (const id of [4, 5]) agents.get(id).quietSince = Date.now() - 3 * 3600000; render(); true`);
  await shot('list-quiet');
  await js(`document.querySelector('.quiet-row').click(); true`);
  await shot('list-quiet-open');
};
