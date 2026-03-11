const Database = require('better-sqlite3');
const config = require('./config');

let db;

function init() {
  db = new Database(config.DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS listings (
      id INTEGER PRIMARY KEY,
      url TEXT NOT NULL,
      title TEXT,
      image_url TEXT,
      current_price REAL,
      min_bid REAL,
      bid_increment REAL,
      buy_now_price REAL,
      remaining_time TEXT,
      end_date TEXT,
      bids INTEGER DEFAULT 0,
      search_term TEXT,
      first_seen_at TEXT DEFAULT (datetime('now')),
      last_seen_at TEXT DEFAULT (datetime('now')),
      is_new INTEGER DEFAULT 1,
      is_hidden INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS scrape_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      total_found INTEGER DEFAULT 0,
      new_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'running'
    );

    CREATE TABLE IF NOT EXISTS search_terms (
      term TEXT PRIMARY KEY,
      max_price REAL,
      cc_enabled INTEGER DEFAULT 1,
      dd_enabled INTEGER DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_listings_is_new ON listings(is_new);
    CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
    CREATE INDEX IF NOT EXISTS idx_listings_buy_now ON listings(buy_now_price);
    CREATE INDEX IF NOT EXISTS idx_listings_hidden ON listings(is_hidden);

    CREATE TABLE IF NOT EXISTS dd_listings (
      id INTEGER PRIMARY KEY,
      url TEXT NOT NULL,
      title TEXT,
      image_url TEXT,
      price REAL,
      search_term TEXT,
      first_seen_at TEXT DEFAULT (datetime('now')),
      last_seen_at TEXT DEFAULT (datetime('now')),
      is_new INTEGER DEFAULT 1,
      is_hidden INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      manually_added INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS dd_scrape_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      total_found INTEGER DEFAULT 0,
      new_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'running'
    );

    CREATE INDEX IF NOT EXISTS idx_dd_listings_is_new ON dd_listings(is_new);
    CREATE INDEX IF NOT EXISTS idx_dd_listings_status ON dd_listings(status);
    CREATE INDEX IF NOT EXISTS idx_dd_listings_price ON dd_listings(price);
    CREATE INDEX IF NOT EXISTS idx_dd_listings_hidden ON dd_listings(is_hidden);
  `);

  // Migrate: add image_url column if missing
  try { db.exec('ALTER TABLE listings ADD COLUMN image_url TEXT'); } catch {}
  // Migrate: add is_hidden column if missing
  try { db.exec('ALTER TABLE listings ADD COLUMN is_hidden INTEGER DEFAULT 0'); } catch {}
  // Migrate: add max_price column to search_terms if missing
  try { db.exec('ALTER TABLE search_terms ADD COLUMN max_price REAL'); } catch {}
  // Migrate: add cc_enabled/dd_enabled columns to search_terms if missing
  try { db.exec('ALTER TABLE search_terms ADD COLUMN cc_enabled INTEGER DEFAULT 1'); } catch {}
  try { db.exec('ALTER TABLE search_terms ADD COLUMN dd_enabled INTEGER DEFAULT 1'); } catch {}
  // Migrate: add manually_added column if missing
  try { db.exec('ALTER TABLE listings ADD COLUMN manually_added INTEGER DEFAULT 0'); } catch {}

  // Migrate: unhide previously price-auto-hidden items stuck as is_hidden=1
  // Going forward, price auto-hides use is_hidden=2 so they can be reversed
  // This one-time pass unhides any is_hidden=1 items whose price is under the current max
  try {
    const termsWithLimits = db.prepare('SELECT term, max_price FROM search_terms WHERE max_price IS NOT NULL').all();
    if (termsWithLimits.length > 0) {
      const mp = new Map(termsWithLimits.map(t => [t.term, t.max_price]));
      const stuck = db.prepare("SELECT id, search_term, buy_now_price, current_price FROM listings WHERE is_hidden = 1 AND status = 'active'").all();
      const toUnhide = [];
      for (const row of stuck) {
        if (!row.search_term) continue;
        const lt = row.search_term.split(',').map(t => t.trim().toLowerCase());
        const allHave = lt.every(t => mp.has(t));
        if (!allHave) continue;
        const price = (row.buy_now_price != null && row.buy_now_price > 0) ? row.buy_now_price : row.current_price;
        if (price == null) continue;
        const underLimit = lt.some(t => price <= mp.get(t));
        if (underLimit) toUnhide.push(row.id);
      }
      if (toUnhide.length > 0) {
        const ph = toUnhide.map(() => '?').join(',');
        db.prepare(`UPDATE listings SET is_hidden = 0 WHERE id IN (${ph})`).run(...toUnhide);
      }
    }
  } catch {}

  // Seed default search terms if table is empty
  const count = db.prepare('SELECT COUNT(*) as c FROM search_terms').get();
  if (count.c === 0) {
    const insert = db.prepare('INSERT INTO search_terms (term) VALUES (?)');
    for (const term of config.DEFAULT_SEARCH_TERMS) {
      insert.run(term);
    }
  }

  return db;
}

function getDb() {
  if (!db) init();
  return db;
}

// Returns { isNew, relisted, isHidden, manuallyAdded }
function upsertListing(listing) {
  const d = getDb();
  const existing = d.prepare('SELECT id, status, is_hidden, manually_added, search_term FROM listings WHERE id = ?').get(listing.id);

  if (existing) {
    const relisted = existing.status === 'ended';
    // When relisted: reset price-auto-hidden (is_hidden=2) so it can be re-evaluated
    // Keep manually hidden (is_hidden=1) — user explicitly hid it
    const newHidden = (relisted && existing.is_hidden === 2) ? 0 : existing.is_hidden;
    // Once manually added, always manually added (protects from auto-hide)
    const isManual = existing.manually_added === 1 || !!listing.manually_added;
    // Keep search_term as 'manual' for manually added items so grouping is preserved
    const searchTerm = isManual ? existing.search_term : listing.search_term;

    d.prepare(`
      UPDATE listings SET
        title = ?, image_url = ?, current_price = ?, min_bid = ?, bid_increment = ?,
        buy_now_price = ?, remaining_time = ?, end_date = ?, bids = ?,
        search_term = ?, last_seen_at = datetime('now'), status = 'active', is_hidden = ?,
        manually_added = ?
      WHERE id = ?
    `).run(
      listing.title, listing.image_url, listing.current_price, listing.min_bid, listing.bid_increment,
      listing.buy_now_price, listing.remaining_time, listing.end_date, listing.bids,
      searchTerm, newHidden, isManual ? 1 : 0, listing.id
    );
    return { isNew: false, relisted, isHidden: newHidden > 0, manuallyAdded: isManual };
  }

  d.prepare(`
    INSERT INTO listings (id, url, title, image_url, current_price, min_bid, bid_increment,
      buy_now_price, remaining_time, end_date, bids, search_term, manually_added)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    listing.id, listing.url, listing.title, listing.image_url, listing.current_price, listing.min_bid,
    listing.bid_increment, listing.buy_now_price, listing.remaining_time,
    listing.end_date, listing.bids, listing.search_term, listing.manually_added ? 1 : 0
  );
  return { isNew: true, relisted: false, isHidden: false, manuallyAdded: !!listing.manually_added };
}

function getAllListings({ sort = 'buy_now_price', direction = 'ASC', filterNew = false, showHidden = false } = {}) {
  const d = getDb();
  const allowedSorts = ['buy_now_price', 'current_price', 'end_date', 'bids', 'first_seen_at'];
  const sortCol = allowedSorts.includes(sort) ? sort : 'buy_now_price';
  const dir = direction === 'DESC' ? 'DESC' : 'ASC';

  const conditions = ["status = 'active'"];
  if (filterNew) conditions.push('is_new = 1');
  if (showHidden) {
    conditions.push('is_hidden > 0');
  } else {
    conditions.push('is_hidden = 0');
  }
  const where = 'WHERE ' + conditions.join(' AND ');

  return d.prepare(`
    SELECT * FROM listings ${where}
    ORDER BY CASE WHEN ${sortCol} IS NULL THEN 1 ELSE 0 END, ${sortCol} ${dir}
  `).all();
}

function getNewCount() {
  return getDb().prepare("SELECT COUNT(*) as count FROM listings WHERE is_new = 1 AND status = 'active' AND is_hidden = 0").get().count;
}

function markSeen(id) {
  getDb().prepare('UPDATE listings SET is_new = 0 WHERE id = ?').run(id);
}

function markAllSeen() {
  getDb().prepare('UPDATE listings SET is_new = 0 WHERE is_new = 1').run();
}

// is_hidden values: 0 = visible, 1 = manually hidden, 2 = auto-hidden by price filter
function hideListing(id) {
  getDb().prepare('UPDATE listings SET is_hidden = 1 WHERE id = ?').run(id);
}

function hideListingByPrice(id) {
  getDb().prepare('UPDATE listings SET is_hidden = 2 WHERE id = ?').run(id);
}

function unhideListing(id) {
  getDb().prepare('UPDATE listings SET is_hidden = 0 WHERE id = ?').run(id);
}

function getHiddenCount() {
  return getDb().prepare("SELECT COUNT(*) as count FROM listings WHERE is_hidden > 0 AND status = 'active'").get().count;
}

function getHiddenIds() {
  // Only skip active hidden items — ended items may be relisted and need re-scraping
  return new Set(getDb().prepare("SELECT id FROM listings WHERE is_hidden > 0 AND status = 'active'").all().map(r => r.id));
}

function createScrapeRun() {
  const result = getDb().prepare('INSERT INTO scrape_runs DEFAULT VALUES').run();
  return result.lastInsertRowid;
}

function completeScrapeRun(id, { totalFound, newCount, status = 'completed' }) {
  getDb().prepare(`
    UPDATE scrape_runs SET completed_at = datetime('now'), total_found = ?, new_count = ?, status = ?
    WHERE id = ?
  `).run(totalFound, newCount, status, id);
}

function getLastScrapeRun() {
  return getDb().prepare('SELECT * FROM scrape_runs ORDER BY id DESC LIMIT 1').get();
}

function getSearchTerms() {
  return getDb().prepare('SELECT term, max_price, cc_enabled, dd_enabled FROM search_terms ORDER BY term').all();
}

function setSearchTerms(terms) {
  const d = getDb();
  d.prepare('DELETE FROM search_terms').run();
  const insert = d.prepare('INSERT INTO search_terms (term, max_price, cc_enabled, dd_enabled) VALUES (?, ?, ?, ?)');
  for (const entry of terms) {
    if (typeof entry === 'string') {
      insert.run(entry.trim().toLowerCase(), null, 1, 1);
    } else {
      insert.run(
        entry.term.trim().toLowerCase(),
        entry.max_price || null,
        entry.cc_enabled != null ? (entry.cc_enabled ? 1 : 0) : 1,
        entry.dd_enabled != null ? (entry.dd_enabled ? 1 : 0) : 1
      );
    }
  }
}

function updateTermSiteEnabled(term, site, enabled) {
  const col = site === 'dd' ? 'dd_enabled' : 'cc_enabled';
  getDb().prepare(`UPDATE search_terms SET ${col} = ? WHERE term = ?`).run(enabled ? 1 : 0, term);
}

function updateTermMaxPrice(term, maxPrice) {
  getDb().prepare('UPDATE search_terms SET max_price = ? WHERE term = ?').run(maxPrice || null, term);
}

function cleanupHiddenListings() {
  const d = getDb();

  // 1. Mark hidden listings as ended if their auction end date has passed
  // end_date format: "MM/DD/YYYY HH:MM:SS"
  const hidden = d.prepare("SELECT id, end_date FROM listings WHERE is_hidden > 0 AND status = 'active'").all();
  const now = new Date();
  const endedIds = [];
  for (const row of hidden) {
    if (!row.end_date) continue;
    const m = row.end_date.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
    if (!m) continue;
    const endDate = new Date(parseInt(m[3]), parseInt(m[1]) - 1, parseInt(m[2]), parseInt(m[4]), parseInt(m[5]), parseInt(m[6]));
    if (endDate < now) endedIds.push(row.id);
  }
  if (endedIds.length > 0) {
    const placeholders = endedIds.map(() => '?').join(',');
    d.prepare(`UPDATE listings SET status = 'ended' WHERE id IN (${placeholders})`).run(...endedIds);
  }

  // 2. Mark hidden listings as ended if none of their search terms are in settings
  // Exclude manually added items — they don't belong to any search term
  const currentTerms = new Set(d.prepare('SELECT term FROM search_terms').all().map(r => r.term));
  const hiddenWithTerms = d.prepare("SELECT id, search_term FROM listings WHERE is_hidden > 0 AND status = 'active' AND manually_added = 0").all();
  const orphanedIds = [];
  for (const row of hiddenWithTerms) {
    if (!row.search_term) { orphanedIds.push(row.id); continue; }
    const listingTerms = row.search_term.split(',').map(t => t.trim().toLowerCase());
    const hasMatch = listingTerms.some(t => currentTerms.has(t));
    if (!hasMatch) orphanedIds.push(row.id);
  }
  if (orphanedIds.length > 0) {
    const placeholders = orphanedIds.map(() => '?').join(',');
    d.prepare(`UPDATE listings SET status = 'ended' WHERE id IN (${placeholders})`).run(...orphanedIds);
  }

  return { expiredCount: endedIds.length, orphanedCount: orphanedIds.length };
}

function applyMaxPriceFilters() {
  const d = getDb();
  // Build map of term -> max_price for terms that have a limit
  const terms = d.prepare('SELECT term, max_price FROM search_terms WHERE max_price IS NOT NULL').all();
  const maxPriceMap = new Map(terms.map(t => [t.term, t.max_price]));

  // --- Unhide pass: restore price-auto-hidden items (is_hidden=2) that are now under the limit ---
  const priceHidden = d.prepare("SELECT id, search_term, buy_now_price, current_price FROM listings WHERE status = 'active' AND is_hidden = 2").all();
  const toUnhide = [];
  for (const row of priceHidden) {
    if (!row.search_term) continue;
    const listingTerms = row.search_term.split(',').map(t => t.trim().toLowerCase());
    const allHaveLimits = listingTerms.every(t => maxPriceMap.has(t));
    const priceToCheck = (row.buy_now_price != null && row.buy_now_price > 0) ? row.buy_now_price : row.current_price;
    // Unhide if: no limits set anymore, or price is now under any term's limit, or no price
    if (!allHaveLimits || priceToCheck == null) {
      toUnhide.push(row.id);
      continue;
    }
    const exceedsAll = listingTerms.every(t => priceToCheck > maxPriceMap.get(t));
    if (!exceedsAll) toUnhide.push(row.id);
  }
  if (toUnhide.length > 0) {
    const ph = toUnhide.map(() => '?').join(',');
    d.prepare(`UPDATE listings SET is_hidden = 0 WHERE id IN (${ph})`).run(...toUnhide);
  }

  // --- Hide pass: hide visible items that exceed all matching terms' limits ---
  // Exclude manually added items — user explicitly added them, they should always show
  if (terms.length === 0) return 0;
  const listings = d.prepare("SELECT id, search_term, buy_now_price, current_price FROM listings WHERE status = 'active' AND is_hidden = 0 AND manually_added = 0").all();
  const toHide = [];
  for (const row of listings) {
    if (!row.search_term) continue;
    const listingTerms = row.search_term.split(',').map(t => t.trim().toLowerCase());
    const allHaveLimits = listingTerms.every(t => maxPriceMap.has(t));
    if (!allHaveLimits) continue;
    const priceToCheck = (row.buy_now_price != null && row.buy_now_price > 0) ? row.buy_now_price : row.current_price;
    if (priceToCheck == null) continue;
    const exceedsAll = listingTerms.every(t => priceToCheck > maxPriceMap.get(t));
    if (exceedsAll) toHide.push(row.id);
  }
  if (toHide.length > 0) {
    const placeholders = toHide.map(() => '?').join(',');
    d.prepare(`UPDATE listings SET is_hidden = 2 WHERE id IN (${placeholders})`).run(...toHide);
  }
  return toHide.length;
}

function markStaleListings(activeIds) {
  if (activeIds.length === 0) return;
  const d = getDb();
  const placeholders = activeIds.map(() => '?').join(',');
  // Exclude manually added items — they won't appear in search results
  d.prepare(`UPDATE listings SET status = 'ended' WHERE status = 'active' AND manually_added = 0 AND id NOT IN (${placeholders})`).run(...activeIds);
}

// ========================
// Dollar Dealers functions
// ========================

function ddUpsertListing(listing) {
  const d = getDb();
  const existing = d.prepare('SELECT id, status, is_hidden, manually_added, search_term FROM dd_listings WHERE id = ?').get(listing.id);

  if (existing) {
    const relisted = existing.status === 'ended';
    const newHidden = (relisted && existing.is_hidden === 2) ? 0 : existing.is_hidden;
    const isManual = existing.manually_added === 1 || !!listing.manually_added;
    const searchTerm = isManual ? existing.search_term : listing.search_term;

    d.prepare(`
      UPDATE dd_listings SET
        title = ?, image_url = ?, price = ?, search_term = ?,
        last_seen_at = datetime('now'), status = 'active', is_hidden = ?, manually_added = ?
      WHERE id = ?
    `).run(
      listing.title, listing.image_url, listing.price,
      searchTerm, newHidden, isManual ? 1 : 0, listing.id
    );
    return { isNew: false, relisted, isHidden: newHidden > 0, manuallyAdded: isManual };
  }

  d.prepare(`
    INSERT INTO dd_listings (id, url, title, image_url, price, search_term, manually_added)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    listing.id, listing.url, listing.title, listing.image_url, listing.price,
    listing.search_term, listing.manually_added ? 1 : 0
  );
  return { isNew: true, relisted: false, isHidden: false, manuallyAdded: !!listing.manually_added };
}

function ddGetAllListings({ sort = 'price', direction = 'ASC', filterNew = false, showHidden = false } = {}) {
  const d = getDb();
  const allowedSorts = ['price', 'first_seen_at'];
  const sortCol = allowedSorts.includes(sort) ? sort : 'price';
  const dir = direction === 'DESC' ? 'DESC' : 'ASC';

  const conditions = ["status = 'active'"];
  if (filterNew) conditions.push('is_new = 1');
  if (showHidden) {
    conditions.push('is_hidden > 0');
  } else {
    conditions.push('is_hidden = 0');
  }
  const where = 'WHERE ' + conditions.join(' AND ');

  return d.prepare(`
    SELECT * FROM dd_listings ${where}
    ORDER BY CASE WHEN ${sortCol} IS NULL THEN 1 ELSE 0 END, ${sortCol} ${dir}
  `).all();
}

function ddGetNewCount() {
  return getDb().prepare("SELECT COUNT(*) as count FROM dd_listings WHERE is_new = 1 AND status = 'active' AND is_hidden = 0").get().count;
}

function ddMarkSeen(id) {
  getDb().prepare('UPDATE dd_listings SET is_new = 0 WHERE id = ?').run(id);
}

function ddMarkAllSeen() {
  getDb().prepare('UPDATE dd_listings SET is_new = 0 WHERE is_new = 1').run();
}

function ddHideListing(id) {
  getDb().prepare('UPDATE dd_listings SET is_hidden = 1 WHERE id = ?').run(id);
}

function ddHideListingByPrice(id) {
  getDb().prepare('UPDATE dd_listings SET is_hidden = 2 WHERE id = ?').run(id);
}

function ddUnhideListing(id) {
  getDb().prepare('UPDATE dd_listings SET is_hidden = 0 WHERE id = ?').run(id);
}

function ddGetHiddenCount() {
  return getDb().prepare("SELECT COUNT(*) as count FROM dd_listings WHERE is_hidden > 0 AND status = 'active'").get().count;
}

function ddGetHiddenIds() {
  return new Set(getDb().prepare("SELECT id FROM dd_listings WHERE is_hidden > 0 AND status = 'active'").all().map(r => r.id));
}

function ddCreateScrapeRun() {
  const result = getDb().prepare('INSERT INTO dd_scrape_runs DEFAULT VALUES').run();
  return result.lastInsertRowid;
}

function ddCompleteScrapeRun(id, { totalFound, newCount, status = 'completed' }) {
  getDb().prepare(`
    UPDATE dd_scrape_runs SET completed_at = datetime('now'), total_found = ?, new_count = ?, status = ?
    WHERE id = ?
  `).run(totalFound, newCount, status, id);
}

function ddGetLastScrapeRun() {
  return getDb().prepare('SELECT * FROM dd_scrape_runs ORDER BY id DESC LIMIT 1').get();
}

function ddCleanupHiddenListings() {
  const d = getDb();
  // No end_date expiry for DD — just orphaned-term cleanup
  const currentTerms = new Set(d.prepare('SELECT term FROM search_terms').all().map(r => r.term));
  const hiddenWithTerms = d.prepare("SELECT id, search_term FROM dd_listings WHERE is_hidden > 0 AND status = 'active' AND manually_added = 0").all();
  const orphanedIds = [];
  for (const row of hiddenWithTerms) {
    if (!row.search_term) { orphanedIds.push(row.id); continue; }
    const listingTerms = row.search_term.split(',').map(t => t.trim().toLowerCase());
    const hasMatch = listingTerms.some(t => currentTerms.has(t));
    if (!hasMatch) orphanedIds.push(row.id);
  }
  if (orphanedIds.length > 0) {
    const placeholders = orphanedIds.map(() => '?').join(',');
    d.prepare(`UPDATE dd_listings SET status = 'ended' WHERE id IN (${placeholders})`).run(...orphanedIds);
  }
  return { orphanedCount: orphanedIds.length };
}

function ddApplyMaxPriceFilters() {
  const d = getDb();
  const terms = d.prepare('SELECT term, max_price FROM search_terms WHERE max_price IS NOT NULL').all();
  const maxPriceMap = new Map(terms.map(t => [t.term, t.max_price]));

  // Unhide pass
  const priceHidden = d.prepare("SELECT id, search_term, price FROM dd_listings WHERE status = 'active' AND is_hidden = 2").all();
  const toUnhide = [];
  for (const row of priceHidden) {
    if (!row.search_term) continue;
    const listingTerms = row.search_term.split(',').map(t => t.trim().toLowerCase());
    const allHaveLimits = listingTerms.every(t => maxPriceMap.has(t));
    if (!allHaveLimits || row.price == null) { toUnhide.push(row.id); continue; }
    const exceedsAll = listingTerms.every(t => row.price > maxPriceMap.get(t));
    if (!exceedsAll) toUnhide.push(row.id);
  }
  if (toUnhide.length > 0) {
    const ph = toUnhide.map(() => '?').join(',');
    d.prepare(`UPDATE dd_listings SET is_hidden = 0 WHERE id IN (${ph})`).run(...toUnhide);
  }

  // Hide pass
  if (terms.length === 0) return 0;
  const listings = d.prepare("SELECT id, search_term, price FROM dd_listings WHERE status = 'active' AND is_hidden = 0 AND manually_added = 0").all();
  const toHide = [];
  for (const row of listings) {
    if (!row.search_term) continue;
    const listingTerms = row.search_term.split(',').map(t => t.trim().toLowerCase());
    const allHaveLimits = listingTerms.every(t => maxPriceMap.has(t));
    if (!allHaveLimits) continue;
    if (row.price == null) continue;
    const exceedsAll = listingTerms.every(t => row.price > maxPriceMap.get(t));
    if (exceedsAll) toHide.push(row.id);
  }
  if (toHide.length > 0) {
    const placeholders = toHide.map(() => '?').join(',');
    d.prepare(`UPDATE dd_listings SET is_hidden = 2 WHERE id IN (${placeholders})`).run(...toHide);
  }
  return toHide.length;
}

function ddMarkStaleListings(activeIds) {
  if (activeIds.length === 0) return;
  const d = getDb();
  const placeholders = activeIds.map(() => '?').join(',');
  d.prepare(`UPDATE dd_listings SET status = 'ended' WHERE status = 'active' AND manually_added = 0 AND id NOT IN (${placeholders})`).run(...activeIds);
}

module.exports = {
  init,
  getDb,
  upsertListing,
  getAllListings,
  getNewCount,
  markSeen,
  markAllSeen,
  hideListing,
  hideListingByPrice,
  unhideListing,
  getHiddenCount,
  getHiddenIds,
  createScrapeRun,
  completeScrapeRun,
  getLastScrapeRun,
  getSearchTerms,
  setSearchTerms,
  updateTermMaxPrice,
  updateTermSiteEnabled,
  cleanupHiddenListings,
  applyMaxPriceFilters,
  markStaleListings,
  // Dollar Dealers
  ddUpsertListing,
  ddGetAllListings,
  ddGetNewCount,
  ddMarkSeen,
  ddMarkAllSeen,
  ddHideListing,
  ddHideListingByPrice,
  ddUnhideListing,
  ddGetHiddenCount,
  ddGetHiddenIds,
  ddCreateScrapeRun,
  ddCompleteScrapeRun,
  ddGetLastScrapeRun,
  ddCleanupHiddenListings,
  ddApplyMaxPriceFilters,
  ddMarkStaleListings,
};
