const EventEmitter = require('events');
const cheerio = require('cheerio');
const config = require('./config');
const db = require('./db');
const { log, describeError } = require('./log');

const fetchPage = typeof fetch !== 'undefined' ? fetch : require('node-fetch');

const DD_BASE_URL = 'https://dollardealers.co.nz';
const DD_MAX_PAGES = 10;

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

function extractProductId(el, $) {
  const classes = $(el).attr('class') || '';
  const match = classes.match(/post-(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

class DDScraper extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.aborted = false;
    // See Scraper: an unhandled 'error' event would crash the add-on process.
    this.on('error', () => {});
  }

  abort() {
    this.aborted = true;
  }

  async fetchWithRetry(url, retries = 2) {
    const attempts = retries + 1;
    for (let i = 0; i < attempts; i++) {
      const started = Date.now();
      try {
        const response = await fetchPage(url, {
          headers: {
            'User-Agent': config.USER_AGENT,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-NZ,en;q=0.9',
          },
          signal: AbortSignal.timeout(config.REQUEST_TIMEOUT_MS),
        });
        const ms = Date.now() - started;

        if (!response.ok) {
          const err = new Error(`HTTP ${response.status}${response.statusText ? ' ' + response.statusText : ''}`);
          err.status = response.status;
          throw err;
        }

        const html = await response.text();
        log.debug('dd', `GET ${url} -> ${response.status} (${html.length} bytes, ${ms}ms)`);
        return { html, finalUrl: response.url };
      } catch (err) {
        const ms = Date.now() - started;
        const attempt = `attempt ${i + 1}/${attempts}`;
        if (i === attempts - 1) {
          log.error('dd', `GET ${url} failed on ${attempt} after ${ms}ms: ${describeError(err)}`);
          throw err;
        }
        log.warn('dd', `GET ${url} failed on ${attempt} after ${ms}ms: ${describeError(err)} — retrying`);
        await delay(1000);
      }
    }
  }

  async scrape(searchTermEntries, { triggerType = 'manual' } = {}) {
    if (this.running) {
      this.emit('error', { message: 'A DD scrape is already in progress' });
      return;
    }

    this.running = true;
    this.aborted = false;
    const runId = db.ddCreateScrapeRun(triggerType);
    let totalFound = 0;
    let newCount = 0;

    const maxPriceMap = new Map();
    for (const entry of searchTermEntries) {
      if (entry.max_price != null) {
        maxPriceMap.set(entry.term, entry.max_price);
      }
    }

    try {
      this.emit('start', { runId });
      log.info('dd', `Scrape #${runId} started (${triggerType}) with ${searchTermEntries.length} search term(s)`);

      // Collect products from search results (with pagination)
      const productMap = new Map(); // id -> { url, title, image_url, price, searchTerms[] }
      const failedTerms = [];

      for (let si = 0; si < searchTermEntries.length; si++) {
        if (this.aborted) break;
        const { term } = searchTermEntries[si];
        const searchTerm = term.replace(/\s+/g, '+');

        this.emit('progress', {
          phase: 'search',
          searchTerm: term,
          searchIndex: si,
          searchTotal: searchTermEntries.length,
          message: `Searching DD for "${term}"...`,
        });

        try {
          let pageIndex = 0;
          let hasMorePages = true;
          let termCount = 0;

          while (hasMorePages && !this.aborted && pageIndex < DD_MAX_PAGES) {
            const pageParam = pageIndex === 0 ? '' : `&paged=${pageIndex + 1}`;
            const searchUrl = `${DD_BASE_URL}/?s=${searchTerm}&post_type=product${pageParam}`;

            if (pageIndex > 0) {
              this.emit('progress', {
                phase: 'search',
                searchTerm: term,
                message: `Searching DD "${term}" page ${pageIndex + 1}...`,
              });
            }

            const { html, finalUrl } = await this.fetchWithRetry(searchUrl);
            const $ = cheerio.load(html);

            // Detect single-result redirect: DD redirects to the product page
            const redirectedToProduct = finalUrl && /\/product\//.test(finalUrl);

            if (redirectedToProduct) {
              // Parse single product page (same selectors as scrapeSingle)
              const bodyClasses = $('body').attr('class') || '';
              const idMatch = bodyClasses.match(/postid-(\d+)/);
              if (idMatch) {
                const id = parseInt(idMatch[1], 10);
                const title = $('.product_title, h1.entry-title').first().text().trim() || '';
                const priceEls = $('.summary .price .woocommerce-Price-amount');
                const price = parsePrice(priceEls.length > 0 ? priceEls.last().text() : null);
                const image = $('.woocommerce-product-gallery img, img.wp-post-image').first().attr('src') || null;

                if (productMap.has(id)) {
                  productMap.get(id).searchTerms.push(term);
                } else {
                  productMap.set(id, { url: finalUrl, title, image_url: image, price, searchTerms: [term] });
                  termCount++;
                }
              }
              hasMorePages = false;
              pageIndex++;
            } else {
              const products = $('div.product-small.col');
              if (products.length === 0) {
                if (pageIndex === 0) {
                  this.emit('progress', {
                    phase: 'search',
                    searchTerm: term,
                    message: `No DD results for "${term}"`,
                  });
                }
                break;
              }

              let pageCount = 0;
              products.each((_, el) => {
                const id = extractProductId(el, $);
                if (!id) return;

                const title = $(el).find('.woocommerce-loop-product__title, h2').first().text().trim();
                // For sale prices, WooCommerce shows <del>old</del><ins>new</ins> — get the last amount
                const priceEls = $(el).find('.price .woocommerce-Price-amount');
                const priceText = priceEls.length > 0 ? priceEls.last().text() : null;
                const price = parsePrice(priceText);
                const image = $(el).find('img').first().attr('src') || null;
                const link = $(el).find('a').first().attr('href') || '';
                const url = link.startsWith('http') ? link : DD_BASE_URL + link;

                if (productMap.has(id)) {
                  productMap.get(id).searchTerms.push(term);
                } else {
                  productMap.set(id, { url, title, image_url: image, price, searchTerms: [term] });
                  pageCount++;
                }
              });

              termCount += pageCount;

              // Check for next page
              const nextLink = $('a.next.page-numbers').attr('href');
              hasMorePages = !!nextLink && pageCount > 0;
              pageIndex++;
            }

            if (hasMorePages) {
              await delay(config.REQUEST_DELAY_MS);
            }
          }

          this.emit('progress', {
            phase: 'search',
            searchTerm: term,
            message: `Found ${termCount} DD listings for "${term}"${pageIndex > 1 ? ` across ${pageIndex} pages` : ''}`,
            count: termCount,
          });
        } catch (err) {
          failedTerms.push(term);
          const detail = describeError(err);
          log.error('dd', `Search for "${term}" failed: ${detail}`);
          this.emit('error', { message: `Error searching DD "${term}": ${detail}`, searchTerm: term });
        }

        await delay(config.REQUEST_DELAY_MS);
      }

      if (failedTerms.length > 0) {
        log.warn('dd', `${failedTerms.length}/${searchTermEntries.length} search term(s) failed: ${failedTerms.join(', ')}`);
      }

      // Upsert all products and apply price filters
      const hiddenIds = db.ddGetHiddenIds();
      const activeIds = [];
      let skippedCount = 0;
      let newVisibleCount = 0;

      for (const [id, product] of productMap) {
        if (this.aborted) break;

        const terms = product.searchTerms;
        const listing = {
          id,
          url: product.url,
          title: product.title,
          image_url: product.image_url,
          price: product.price,
          search_term: terms.join(', '),
        };

        const { isNew, relisted, isHidden: alreadyHidden, manuallyAdded, priceOverride } = db.ddUpsertListing(listing);
        if (isNew) newCount++;
        activeIds.push(id);
        totalFound++;

        // Auto-hide if price exceeds max
        let autoHidden = false;
        if (!alreadyHidden && !manuallyAdded && !priceOverride && product.price != null) {
          const allTermsHaveLimits = terms.every(t => maxPriceMap.get(t) != null);
          if (allTermsHaveLimits) {
            const exceedsAll = terms.every(t => product.price > maxPriceMap.get(t));
            if (exceedsAll) {
              db.ddHideListingByPrice(id);
              autoHidden = true;
              skippedCount++;
            }
          }
        }

        if (!autoHidden && !alreadyHidden && !hiddenIds.has(id)) {
          if (isNew) newVisibleCount++;
          this.emit('listing', { ...listing, is_new: isNew ? 1 : 0, first_seen_at: new Date().toISOString() });
        }
      }

      // Also include hidden items found in results so they don't get purged
      for (const id of hiddenIds) {
        if (productMap.has(id) && !activeIds.includes(id)) {
          activeIds.push(id);
        }
      }

      // Skipped when any search term failed — otherwise a network failure would
      // wrongly mark healthy listings as ended.
      if (this.aborted) {
        log.info('dd', 'Aborted — skipping stale-listing cleanup');
      } else if (failedTerms.length > 0) {
        log.warn('dd', `Skipping stale-listing cleanup — ${failedTerms.length} search term(s) failed this run`);
      } else if (activeIds.length > 0) {
        db.ddMarkStaleListings(activeIds);
      }

      const allTermsFailed = searchTermEntries.length > 0 && failedTerms.length === searchTermEntries.length;
      let status = 'completed';
      if (this.aborted) status = 'aborted';
      else if (allTermsFailed) status = 'error';
      else if (failedTerms.length > 0) status = 'partial';

      db.ddCompleteScrapeRun(runId, { totalFound, newCount, status });

      log.info('dd', `Scrape #${runId} ${status}: ${totalFound} found, ${newCount} new (${newVisibleCount} visible), ${skippedCount} price-filtered, ${failedTerms.length} term failure(s)`);
      if (allTermsFailed) {
        log.error('dd', 'Every search term failed — see the errors above; the site was unreachable or rejected every request');
      }

      this.emit('complete', {
        totalFound,
        newCount,
        newVisibleCount,
        skippedCount,
        failedTerms,
        status,
        aborted: this.aborted,
      });
    } catch (err) {
      db.ddCompleteScrapeRun(runId, { totalFound, newCount, status: 'error' });
      const detail = describeError(err);
      log.error('dd', `Scrape #${runId} crashed: ${detail}`);
      this.emit('error', { message: `DD scrape failed: ${detail}` });
    } finally {
      this.running = false;
    }
  }

  async scrapeSingle(inputUrl) {
    let url = inputUrl.trim();
    if (!url.startsWith('http')) {
      throw new Error('Please provide a full Dollar Dealers product URL');
    }

    const { html } = await this.fetchWithRetry(url);
    const $ = cheerio.load(html);

    // Extract product ID from body class (postid-XXXXX)
    const bodyClasses = $('body').attr('class') || '';
    const idMatch = bodyClasses.match(/postid-(\d+)/);
    if (!idMatch) throw new Error('Could not extract product ID from page');
    const id = parseInt(idMatch[1], 10);

    const title = $('.product_title, h1.entry-title').first().text().trim() || 'Title not found';
    const priceEls = $('.summary .price .woocommerce-Price-amount');
    const price = parsePrice(priceEls.length > 0 ? priceEls.last().text() : null);
    const image = $('.woocommerce-product-gallery img, img.wp-post-image').first().attr('src') || null;

    const listing = { id, url, title, image_url: image, price, search_term: 'manual', manually_added: true };
    const { isNew } = db.ddUpsertListing(listing);
    return { ...listing, is_new: isNew ? 1 : 0, first_seen_at: new Date().toISOString() };
  }
}

module.exports = DDScraper;
