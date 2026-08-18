const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('./src/db');
const { router: routes, setupSchedule } = require('./src/routes');
const config = require('./src/config');
const { log } = require('./src/log');

// Startup diagnostics — these lines appear in the HA add-on log and are the
// first thing to check when scraping fails.
log.info('startup', `Node ${process.version} | db ${config.DB_PATH} | request timeout ${config.REQUEST_TIMEOUT_MS}ms`);
const extraCa = process.env.NODE_EXTRA_CA_CERTS;
if (extraCa && fs.existsSync(extraCa)) {
  const count = (fs.readFileSync(extraCa, 'utf8').match(/BEGIN CERTIFICATE/g) || []).length;
  log.info('startup', `Extra CA bundle loaded: ${extraCa} (${count} certificate(s))`);
} else if (extraCa) {
  log.error('startup', `NODE_EXTRA_CA_CERTS points at a missing file: ${extraCa} — TLS to sites with incomplete chains will fail`);
} else {
  log.warn('startup', 'NODE_EXTRA_CA_CERTS is not set — sites that omit their intermediate certificate will fail to load');
}
if (log.debugEnabled) log.info('startup', 'Debug logging enabled (LOG_LEVEL=debug)');

db.init();

const app = express();

app.use(express.static(path.join(__dirname, 'public')));
app.use(routes);

setupSchedule();

app.listen(config.PORT, () => {
  log.info('startup', `Auction Scraper running at http://localhost:${config.PORT}`);
});
