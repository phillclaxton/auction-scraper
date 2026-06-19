const http = require('http');

/**
 * Send a notification through the Home Assistant Supervisor API.
 * Silently no-ops if SUPERVISOR_TOKEN is not present (standalone Docker).
 *
 * @param {object} opts
 * @param {string} opts.service  - HA notify service name (e.g. 'persistent_notification', 'mobile_app_iphone')
 * @param {string} opts.title    - Notification title
 * @param {string} opts.message  - Notification body
 */
function sendHANotification({ service, title, message }) {
  const token = process.env.SUPERVISOR_TOKEN;
  if (!token) return; // not running as HA add-on — skip silently

  const body = JSON.stringify({ title, message });
  const req = http.request({
    hostname: 'supervisor',
    port: 80,
    path: `/core/api/services/notify/${service}`,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, (res) => {
    if (res.statusCode < 200 || res.statusCode >= 300) {
      console.warn(`[notifier] HA notification failed: HTTP ${res.statusCode} for service "${service}"`);
    }
  });

  req.on('error', err => console.warn(`[notifier] HA notification error: ${err.message}`));
  req.write(body);
  req.end();
}

/**
 * Build and send a scrape-complete notification.
 * Fires only for new items that are actually visible — i.e. new AND not hidden
 * by the price filter. Skips aborted runs and runs with no new visible items.
 *
 * @param {object} opts
 * @param {number} opts.newVisibleCount - New listings that passed the price filter
 * @param {number} opts.totalFound      - Total listings found this run
 * @param {string} opts.source          - 'cc' or 'dd'
 * @param {boolean} opts.aborted        - Whether the scrape was aborted
 * @param {string}  opts.service        - HA notify service name
 */
function notifyScrapeComplete({ newVisibleCount, totalFound, source, aborted, service }) {
  if (aborted || !newVisibleCount) return;

  const sourceName = source === 'dd' ? 'Dollar Dealers' : 'Cash Converters';
  sendHANotification({
    service,
    title: `Auction Scraper — ${newVisibleCount} new listing${newVisibleCount > 1 ? 's' : ''}`,
    message: `${newVisibleCount} new item${newVisibleCount > 1 ? 's' : ''} found on ${sourceName} (${totalFound} total). Open the Auction Scraper panel to view them.`,
  });
}

module.exports = { sendHANotification, notifyScrapeComplete };
