// Child process for the one-time $ backfill of old usage windows (main.js backfillUsageCosts):
// it can stream GBs of transcripts, so it runs here at low priority instead of in the app.
const { windowCosts } = require('./api-cost');
process.on('message', async ({ root, wins }) => { process.send(await windowCosts(root, wins)); process.exit(0); });
