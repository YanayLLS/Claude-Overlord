// Settings → Phone: off, running with a LAN and a Tailscale address, and failed.
//   npx electron scripts/shot/run.js scripts/shot/scenarios/phone.js <outDir>
const { qrSvg } = require('../../../mobile-server');
module.exports = async ({ inject, js, shot, wait }) => {
  const addr = (address, kind, iface) => ({ address, kind, iface, url: `http://${address}:7791`, qr: qrSvg(`http://${address}:7791/#k=made-up-token-for-the-shot-0123456789abcdef`) });
  await js(`toggleSettings(); showSettingsSec('phone'); true`);
  await inject({ type: 'mobileState', enabled: false, running: false, port: 0, addresses: [] });
  await wait(300); await shot('phone-off');
  await inject({ type: 'mobileState', enabled: true, running: true, port: 7791, addresses: [addr('100.101.2.3', 'tailscale', 'Tailscale'), addr('192.168.1.20', 'lan', 'Wi-Fi')] });
  await wait(300); await shot('phone-on');
  await js(`document.querySelector('#phone-pick button:nth-child(2)').click(); true`);
  await wait(200); await shot('phone-lan');
  await inject({ type: 'mobileState', enabled: true, running: false, port: 0, error: 'Port in use', addresses: [] });
  await wait(300); await shot('phone-failed');
};
