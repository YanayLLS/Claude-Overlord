// Settings → Local API: off, running, and right after New token.
//   npx electron scripts/shot/run.js scripts/shot/scenarios/local-api.js <outDir>
module.exports = async ({ inject, js, shot, wait, onCmd }) => {
  const file = 'C:/Users/me/.overlord/api.json';
    onCmd((m, reply) => { if (m.type === 'apiNewToken') { reply({ type: 'apiState', enabled: true, running: true, port: 7790, file, tokenTail: 'Ja1P', rotated: true }); } });
  await js(`toggleSettings(); showSettingsSec('api'); true`);
  await inject({ type: 'apiState', enabled: false, running: false, port: 0, file });
  await wait(300); await shot('off');
  await inject({ type: 'apiState', enabled: true, running: true, port: 7790, file, tokenTail: 'S0aE' });
  await wait(300); await shot('running');
  await js(`(document.querySelector('[data-api-rotate]') || [...document.querySelectorAll('#settings-overlay button')].find(b => b.textContent.trim() === 'New token')).click(); true`);
  await wait(300); await shot('rotate-1');
  const c = await js(`!!document.querySelector('[data-api-rotate-confirm]')`);
  if (c) { await js(`document.querySelector('[data-api-rotate-confirm]').click(); true`); await wait(250); await shot('rotate-2'); }
  await inject({ type: 'apiState', enabled: true, running: false, port: 0, file, error: 'Port in use' });
  await wait(300); await shot('failed');
  await inject({ type: 'apiState', enabled: true, running: true, port: 7790, file, tokenTail: 'Ja1P' });
  await js(`document.getElementById('api-copy-cfg').click(); true`); await wait(100); await shot('copied');
};
