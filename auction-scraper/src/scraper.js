const EventEmitter = require('events');
const cheerio = require('cheerio');
const config = require('./config');
const db = require('./db');

// Node 18 has global fetch, but we need to handle the case where it doesn't
const fetchPage = typeof fetch !== 'undefined' ? fetch : require('node-fetch');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parsePrice(text) {
  if (!text) return null;
  const match = text.replace(/,/g, '').match(/(\d+\.\d+)/);
  if (match) return parseFloat(match[1]);
  const intMatch = text.match(/(\d+)/);
  if (intMatch) return parseFloat(intMatch[1]);
  return null;
}

function extractListingId(url) {
  const match = url.match(config.LISTING_ID_PATTERN);
  return match ? parseInt(match[1], 10) : null;
}

function parseListingHtml(html, id, url, searchTerm) {
  const $ = cheerio.load(html);

  const title = $(config.SELECTORS.TITLE).first().text().trim()
    || $('h3').first().text().trim()
    || $('h1').first().text().trim()
    || 'Title not found';

  const currentPrice = parsePrice($(config.SELECTORS.CURRENT_PRICE).first().text());
  const minBid = parsePrice($(config.SELECTORS.MIN_BID).first().text());
  const bidIncrement = parsePrice($(config.SELECTORS.BID_INCREMENT).first().text());
  const buyNowRaw = parsePrice($(config.SELECTORS.BUY_NOW_PRICE).first().text());
  const buyNowPrice = buyNowRaw && buyNowRaw > 0 ? buyNowRaw : null;
  const remainingTime = $(config.SELECTORS.REMAINING_TIME).first().text().trim() || null;
  const endDateEl = $(config.SELECTORS.END_DATE).first();
  const endDate = endDateEl.attr('data-action-time') || endDateEl.text().trim() || null;
  const bids = parseInt($(config.SELECTORS.BIDS_COUNT).first().text().trim(), 10) || 0;

  let imageUrl = null;
  const imgEl = $(config.SELECTORS.IMAGE).first();
  if (imgEl.length) {
    imageUrl = imgEl.attr('src') || null;
  }
  if (!imageUrl) {
    const altImg = $('img[src*="auctionworx"]').first();
    if (altImg.length) imageUrl = altImg.attr('src');
  }

  return {
    id, url, title, image_url: imageUrl,
    current_price: currentPrice, min_bid: minBid, bid_increment: bidIncrement,
    buy_now_price: buyNowPrice, remaining_time: remainingTime, end_date: endDate,
    bids, search_term: searchTerm,
  };
}

class Scraper extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.aborted = false;
  }

  abort() {
    this.aborted = true;
  }

  async fetchWithRetry(url, retries = 2) {
    for (let i = 0; i <= retries; i++) {
      try {
        const response = await fetchPage(url, {
          headers: {
            'User-Agent': config.USER_AGENT,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-NZ,en;q=0.9',
          },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.text();
      } catch (err) {
        if (i === retries) throw err;
        await delay(1000);
      }
    }
  }

  async scrape(searchTermEntries, { triggerType = 'manual' } = {}) {
    // searchTermEntries: [{ term, max_price }]
    if (this.running) {
      this.emit('error', { message: 'A scrape is already in progress' });
      return;
    }

    this.running = true;
    this.aborted = false;
    const runId = db.createScrapeRun(triggerType);
    let totalFound = 0;
    let newCount = 0;

    // Build a map of term -> max_price for filtering
    const maxPriceMap = new Map();
    for (const entry of searchTermEntries) {
      if (entry.max_price != null) {
        maxPriceMap.set(entry.term, entry.max_price);
      }
    }

    try {
      this.emit('start', { runId });

      // Phase 1: Collect listing URLs from all search terms (with pagination)
      const listingMap = new Map(); // id -> { url, searchTerms[] }
      const MAX_PAGES = 10; // safety limit

      for (let si = 0; si < searchTermEntries.length; si++) {
        if (this.aborted) break;
        const { term, max_price } = searchTermEntries[si];
        const encodedTerm = encodeURIComponent(term);
        const priceParam = max_price != null ? `&PriceHigh=${max_price}` : '';

        this.emit('progress', {
          phase: 'search',
          searchTerm: term,
          searchIndex: si,
          searchTotal: searchTermEntries.length,
          message: `Searching for "${term}"...`,
        });

        try {
          const urls = [];
          let pageIndex = 0;
          let hasMorePages = true;

          while (hasMorePages && !this.aborted && pageIndex < MAX_PAGES) {
            const pageParam = pageIndex === 0 ? '' : `&page=${pageIndex}`;
            const searchUrl = `${config.BASE_URL}/Browse?FullTextQuery=${encodedTerm}${priceParam}${pageParam}`;

            if (pageIndex > 0) {
              this.emit('progress', {
                phase: 'search',
                searchTerm: term,
                message: `Searching "${term}" page ${pageIndex + 1}...`,
              });
            }

            const html = await this.fetchWithRetry(searchUrl);
            const $ = cheerio.load(html);

            // Check for no results (only on first page)
            if (pageIndex === 0) {
              const noResults = $(config.SELECTORS.NO_RESULTS).length > 0;
              if (noResults) {
                this.emit('progress', {
                  phase: 'search',
                  searchTerm: term,
                  message: `No results for "${term}"`,
                });
                break;
              }
            }

            // Find listing links on this page
            const links = $(config.SELECTORS.LISTING_LINKS);
            let pageCount = 0;

            links.each((_, el) => {
              const href = $(el).attr('href');
              if (!href) return;
              const fullUrl = href.startsWith('http') ? href : config.BASE_URL + href;
              const id = extractListingId(fullUrl);
              if (id && /\/Listing\/Details\/\d+$/.test(new URL(fullUrl).pathname)) {
                if (!urls.some(u => u.id === id)) {
                  urls.push({ id, url: fullUrl });
                  pageCount++;
                }
              }
            });

            // Check for next page by looking for a pagination link to the next page index
            const nextPageExists = $('a[href*="page="]').filter((_, el) => {
              const href = $(el).attr('href') || '';
              const match = href.match(/[?&]page=(\d+)/);
              return match && parseInt(match[1], 10) === pageIndex + 1;
            }).length > 0;

            hasMorePages = nextPageExists && pageCount > 0;
            pageIndex++;

            if (hasMorePages) {
              await delay(config.REQUEST_DELAY_MS);
            }
          }

          this.emit('progress', {
            phase: 'search',
            searchTerm: term,
            message: `Found ${urls.length} listings for "${term}"${pageIndex > 1 ? ` across ${pageIndex} pages` : ''}`,
            count: urls.length,
          });

          for (const { id, url } of urls) {
            if (listingMap.has(id)) {
              listingMap.get(id).searchTerms.push(term);
            } else {
              listingMap.set(id, { url, searchTerms: [term] });
            }
          }
        } catch (err) {
          this.emit('error', { message: `Error searching "${term}": ${err.message}`, searchTerm: term });
        }

        await delay(config.REQUEST_DELAY_MS);
      }

      // Phase 2: Fetch each unique listing detail page, skipping hidden ones
      const hiddenIds = db.getHiddenIds();
      const allIdsRaw = Array.from(listingMap.keys());
      const hiddenInResults = allIdsRaw.filter(id => hiddenIds.has(id));
      const hiddenSkipped = hiddenInResults.length;
      const allIds = allIdsRaw.filter(id => !hiddenIds.has(id));
      const total = allIds.length;

      if (hiddenSkipped > 0) {
        this.emit('progress', {
          phase: 'details',
          message: `Skipped ${hiddenSkipped} hidden listing${hiddenSkipped > 1 ? 's' : ''}, scraping ${total}...`,
          current: 0,
          total,
        });
      } else {
        this.emit('progress', {
          phase: 'details',
          message: `Scraping ${total} unique listings...`,
          current: 0,
          total,
        });
      }

      // Hidden items found in search results are still active — include them
      // so markStaleListings doesn't purge them
      const activeIds = [...hiddenInResults];
      let skippedCount = 0;

      for (let i = 0; i < allIds.length; i++) {
        if (this.aborted) break;
        const id = allIds[i];
        const { url, searchTerms: terms } = listingMap.get(id);

        this.emit('progress', {
          phase: 'details',
          message: `Scraping listing ${i + 1}/${total}...`,
          current: i + 1,
          total,
          percent: Math.round(((i + 1) / total) * 100),
        });

        try {
          const html = await this.fetchWithRetry(url);
          const listing = parseListingHtml(html, id, url, terms.join(', '));

          const { isNew, relisted, isHidden: alreadyHidden, manuallyAdded } = db.upsertListing(listing);
          if (isNew) newCount++;
          activeIds.push(id);
          totalFound++;

          if (relisted) {
            this.emit('progress', {
              phase: 'details',
              message: `Relisted: "${listing.title}"`,
              current: i + 1,
              total,
              percent: Math.round(((i + 1) / total) * 100),
            });
          }

          // Auto-hide if price exceeds all matching terms' max price limits
          // Check buy_now_price first; if absent, fall back to current_price
          // Skip if already manually hidden or manually added — don't override user's choice
          let autoHidden = false;
          if (!alreadyHidden && !manuallyAdded) {
            const allTermsHaveLimits = terms.every(t => maxPriceMap.get(t) != null);
            const priceToCheck = (listing.buy_now_price != null && listing.buy_now_price > 0) ? listing.buy_now_price : listing.current_price;
            if (allTermsHaveLimits && priceToCheck != null) {
              const exceedsAll = terms.every(t => priceToCheck > maxPriceMap.get(t));
              if (exceedsAll) {
                db.hideListingByPrice(id);
                autoHidden = true;
                skippedCount++;
                this.emit('progress', {
                  phase: 'details',
                  message: `Auto-hidden "${listing.title}" ($${priceToCheck} exceeds max)`,
                  current: i + 1,
                  total,
                  percent: Math.round(((i + 1) / total) * 100),
                });
              }
            }
          }

          if (!autoHidden && !alreadyHidden) {
            this.emit('listing', { ...listing, is_new: isNew ? 1 : 0, first_seen_at: new Date().toISOString() });
          }
        } catch (err) {
          this.emit('error', { message: `Error scraping listing ${id}: ${err.message}`, url });
        }

        await delay(config.REQUEST_DELAY_MS);
      }

      // Mark listings not found in this run as ended
      if (!this.aborted && activeIds.length > 0) {
        db.markStaleListings(activeIds);
      }

      db.completeScrapeRun(runId, { totalFound, newCount, status: this.aborted ? 'aborted' : 'completed' });

      this.emit('complete', {
        totalFound,
        newCount,
        skippedCount,
        aborted: this.aborted,
      });
    } catch (err) {
      db.completeScrapeRun(runId, { totalFound, newCount, status: 'error' });
      this.emit('error', { message: `Scrape failed: ${err.message}` });
    } finally {
      this.running = false;
    }
  }

  async scrapeSingle(inputUrl) {
    // Normalise URL: accept full URL (with optional slug after ID), or just the ID
    let url = inputUrl.trim();
    const idMatch = url.match(config.LISTING_ID_PATTERN) || url.match(/(\d+)\s*$/);
    if (!idMatch) throw new Error('Could not extract listing ID from URL');
    const id = parseInt(idMatch[1], 10);

    if (!url.startsWith('http')) {
      url = `${config.BASE_URL}/Listing/Details/${id}`;
    }

    const html = await this.fetchWithRetry(url);
    const listing = parseListingHtml(html, id, url, 'manual');
    listing.manually_added = true;
    const { isNew } = db.upsertListing(listing);
    return { ...listing, is_new: isNew ? 1 : 0, first_seen_at: new Date().toISOString() };
  }
}

module.exports = Scraper;
