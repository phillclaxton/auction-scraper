const path = require('path');

module.exports = {
  BASE_URL: 'https://shop.cashconverters.co.nz',

  DEFAULT_SEARCH_TERMS: [
    'jbl flip 6',
    'jbl flip 7',
    'marshall stanmore',
  ],

  USER_AGENT:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',

  REQUEST_DELAY_MS: 1000,

  DB_PATH: path.join(__dirname, '..', 'data', 'auctions.db'),

  PORT: process.env.PORT || 3456,

  // CSS selectors matching the original Python scraper
  SELECTORS: {
    NO_RESULTS: '.browse-no-results',
    LISTING_LINKS: 'a[href*="/Listing/Details/"]',
    TITLE: 'h3.awe-listing-detail-title',
    CURRENT_PRICE: '.Bidding_Current_Price',
    MIN_BID: '.Bidding_Listing_MinPrice',
    BID_INCREMENT: '.Bidding_Listing_Increment',
    BUY_NOW_PRICE: '.awe-rt-BuyNowPrice',
    END_DATE: 'small[data-action-time]',
    BIDS_COUNT: '.awe-rt-AcceptedListingActionCount',
    REMAINING_TIME: 'small[data-epoch="ending"]',
    IMAGE: 'img#previewimg',
  },

  LISTING_ID_PATTERN: /\/Listing\/Details\/(\d+)/,
};
