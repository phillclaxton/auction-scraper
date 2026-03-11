const express = require('express');
const db = require('./db');
const Scraper = require('./scraper');
const DDScraper = require('./dd-scraper');

const router = express.Router();
const scraper = new Scraper();
const ddScraper = new DDScraper();

// Connected SSE clients
let sseClients = [];

// Pipe scraper events to all SSE clients
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients = sseClients.filter(res => {
    try {
      res.write(msg);
      return true;
    } catch {
      return false;
    }
  });
}

// CC scraper events
scraper.on('start', data => broadcast('start', { ...data, source: 'cc' }));
scraper.on('progress', data => broadcast('progress', { ...data, source: 'cc' }));
scraper.on('listing', data => broadcast('listing', { ...data, source: 'cc' }));
scraper.on('complete', data => broadcast('complete', { ...data, source: 'cc' }));
scraper.on('error', data => broadcast('error', { ...data, source: 'cc' }));

// DD scraper events
ddScraper.on('start', data => broadcast('start', { ...data, source: 'dd' }));
ddScraper.on('progress', data => broadcast('progress', { ...data, source: 'dd' }));
ddScraper.on('listing', data => broadcast('listing', { ...data, source: 'dd' }));
ddScraper.on('complete', data => broadcast('complete', { ...data, source: 'dd' }));
ddScraper.on('error', data => broadcast('error', { ...data, source: 'dd' }));

// --- API Routes ---

router.get('/api/listings', (req, res) => {
  const source = req.query.source || 'cc';
  const { sort, direction, filterNew, showHidden } = req.query;
  const opts = { sort, direction, filterNew: filterNew === 'true', showHidden: showHidden === 'true' };

  if (source === 'dd') {
    db.ddCleanupHiddenListings();
    db.ddApplyMaxPriceFilters();
    const listings = db.ddGetAllListings(opts);
    return res.json({ listings, newCount: db.ddGetNewCount(), hiddenCount: db.ddGetHiddenCount() });
  }

  db.cleanupHiddenListings();
  db.applyMaxPriceFilters();
  const listings = db.getAllListings(opts);
  res.json({ listings, newCount: db.getNewCount(), hiddenCount: db.getHiddenCount() });
});

router.post('/api/scrape', express.json(), (req, res) => {
  const source = (req.body && req.body.source) || 'cc';
  const allTerms = db.getSearchTerms();

  if (source === 'dd') {
    if (ddScraper.running) return res.status(409).json({ error: 'DD scrape already in progress' });
    const terms = allTerms.filter(t => t.dd_enabled);
    ddScraper.scrape(terms);
    return res.status(202).json({ message: 'DD scrape started', searchTerms: terms, source: 'dd' });
  }

  if (scraper.running) return res.status(409).json({ error: 'Scrape already in progress' });
  const terms = allTerms.filter(t => t.cc_enabled);
  scraper.scrape(terms);
  res.status(202).json({ message: 'Scrape started', searchTerms: terms, source: 'cc' });
});

router.post('/api/scrape/single', express.json(), async (req, res) => {
  const { url, source } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  try {
    const activeScraper = source === 'dd' ? ddScraper : scraper;
    const listing = await activeScraper.scrapeSingle(url);
    res.json({ listing, source: source || 'cc' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/api/scrape/abort', express.json(), (req, res) => {
  const source = (req.body && req.body.source) || 'cc';
  const activeScraper = source === 'dd' ? ddScraper : scraper;
  if (!activeScraper.running) return res.status(400).json({ error: 'No scrape in progress' });
  activeScraper.abort();
  res.json({ message: 'Abort requested' });
});

router.get('/api/scrape/progress', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  res.write(`event: connected\ndata: ${JSON.stringify({
    ccRunning: scraper.running,
    ddRunning: ddScraper.running,
  })}\n\n`);

  sseClients.push(res);
  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== res);
  });
});

router.post('/api/listings/:id/seen', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const source = req.query.source || 'cc';
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  source === 'dd' ? db.ddMarkSeen(id) : db.markSeen(id);
  res.json({ ok: true });
});

router.post('/api/listings/mark-all-seen', (req, res) => {
  const source = req.query.source || 'cc';
  source === 'dd' ? db.ddMarkAllSeen() : db.markAllSeen();
  res.json({ ok: true });
});

router.post('/api/listings/:id/hide', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const source = req.query.source || 'cc';
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  source === 'dd' ? db.ddHideListing(id) : db.hideListing(id);
  res.json({ ok: true });
});

router.post('/api/listings/:id/unhide', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const source = req.query.source || 'cc';
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  source === 'dd' ? db.ddUnhideListing(id) : db.unhideListing(id);
  res.json({ ok: true });
});

router.get('/api/config', (req, res) => {
  res.json({
    searchTerms: db.getSearchTerms(),
    lastRun: db.getLastScrapeRun() || null,
    ddLastRun: db.ddGetLastScrapeRun() || null,
  });
});

router.post('/api/config', express.json(), (req, res) => {
  const { searchTerms } = req.body;
  if (!Array.isArray(searchTerms) || searchTerms.length === 0) {
    return res.status(400).json({ error: 'searchTerms must be a non-empty array' });
  }
  db.setSearchTerms(searchTerms);
  db.cleanupHiddenListings();
  db.ddCleanupHiddenListings();
  res.json({ searchTerms: db.getSearchTerms() });
});

router.post('/api/config/site-enabled', express.json(), (req, res) => {
  const { term, site, enabled } = req.body;
  if (!term || !site) return res.status(400).json({ error: 'term and site are required' });
  db.updateTermSiteEnabled(term, site, enabled);
  res.json({ ok: true, searchTerms: db.getSearchTerms() });
});

router.post('/api/config/max-price', express.json(), (req, res) => {
  const { term, maxPrice } = req.body;
  if (!term) return res.status(400).json({ error: 'term is required' });
  db.updateTermMaxPrice(term, maxPrice);
  db.applyMaxPriceFilters();
  db.ddApplyMaxPriceFilters();
  res.json({ ok: true, searchTerms: db.getSearchTerms() });
});

module.exports = router;
