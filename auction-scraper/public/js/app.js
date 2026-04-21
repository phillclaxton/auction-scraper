(function () {
  // State
  let listings = [];
  let currentFilter = 'all';
  let currentSort = 'buy_now_price:ASC';
  let currentSource = 'cc'; // 'cc' or 'dd'
  let eventSource = null;
  let ccRunning = false;
  let ddRunning = false;
  let searchTermsConfig = []; // [{ term, max_price }]
  let groupByTerm = false;
  const collapsedGroups = new Set();

  // Sort options per source
  const SORT_OPTIONS = {
    cc: [
      { value: 'buy_now_price:ASC', label: 'Buy Now (low-high)' },
      { value: 'buy_now_price:DESC', label: 'Buy Now (high-low)' },
      { value: 'current_price:ASC', label: 'Current Price (low-high)' },
      { value: 'current_price:DESC', label: 'Current Price (high-low)' },
      { value: 'end_date:ASC', label: 'Ending Soon' },
      { value: 'bids:DESC', label: 'Most Bids' },
      { value: 'first_seen_at:DESC', label: 'Newest First' },
    ],
    dd: [
      { value: 'price:ASC', label: 'Price (low-high)' },
      { value: 'price:DESC', label: 'Price (high-low)' },
      { value: 'first_seen_at:DESC', label: 'Newest First' },
      { value: 'title:ASC', label: 'Title (A-Z)' },
    ],
  };

  // Default sorts per source
  const DEFAULT_SORT = { cc: 'buy_now_price:ASC', dd: 'price:ASC' };

  // Schedule state
  let scheduleConfig = { enabled: true, intervalHours: 4, startHour: 6, endHour: 20 };

  // Notify state
  let notifyConfig = { enabled: false, service: 'persistent_notification' };

  // DOM refs
  const btnScrape = document.getElementById('btn-scrape');
  const btnAbort = document.getElementById('btn-abort');
  const btnMarkAll = document.getElementById('btn-mark-all');
  const btnSettings = document.getElementById('btn-settings');
  const btnAddTerm = document.getElementById('btn-add-term');
  const newTermInput = document.getElementById('new-term-input');
  const btnAddUrl = document.getElementById('btn-add-url');
  const addUrlInput = document.getElementById('add-url-input');
  const progressSection = document.getElementById('progress-section');
  const progressBar = document.getElementById('progress-bar');
  const progressText = document.getElementById('progress-text');
  const sortSelect = document.getElementById('sort-select');
  const listingsGrid = document.getElementById('listings-grid');
  const emptyState = document.getElementById('empty-state');
  const lastRunEl = document.getElementById('last-run');
  const newBadge = document.getElementById('new-badge');
  const hiddenBadge = document.getElementById('hidden-badge');
  const settingsPanel = document.getElementById('settings-panel');
  const termsList = document.getElementById('terms-list');
  const groupByTermCheckbox = document.getElementById('group-by-term');
  const filterButtons = document.querySelectorAll('.btn-filter');
  const sourceTabs = document.querySelectorAll('.source-tab');
  const scheduleEnabledCb = document.getElementById('schedule-enabled');
  const scheduleIntervalSel = document.getElementById('schedule-interval');
  const scheduleStartSel = document.getElementById('schedule-start-hour');
  const scheduleEndSel = document.getElementById('schedule-end-hour');
  const scheduleFields = document.getElementById('schedule-fields');
  const schedulePreview = document.getElementById('schedule-preview');
  const btnSaveSchedule = document.getElementById('btn-save-schedule');
  const notifyEnabledCb = document.getElementById('notify-enabled');
  const notifyServiceInput = document.getElementById('notify-service');
  const notifyFields = document.getElementById('notify-fields');
  const btnSaveNotify = document.getElementById('btn-save-notify');

  // --- Init ---
  async function init() {
    buildSortOptions();
    buildHourSelects();
    await fetchListings();
    await fetchConfig();
    connectSSE();
    bindEvents();
  }

  function bindEvents() {
    btnScrape.addEventListener('click', startScrape);
    btnAbort.addEventListener('click', abortScrape);
    btnMarkAll.addEventListener('click', markAllSeen);
    btnSettings.addEventListener('click', toggleSettings);
    btnAddTerm.addEventListener('click', addTerm);
    newTermInput.addEventListener('keydown', e => { if (e.key === 'Enter') addTerm(); });
    btnAddUrl.addEventListener('click', addByUrl);
    addUrlInput.addEventListener('keydown', e => { if (e.key === 'Enter') addByUrl(); });
    sortSelect.addEventListener('change', () => {
      currentSort = sortSelect.value;
      fetchListings();
    });
    groupByTermCheckbox.addEventListener('change', () => {
      groupByTerm = groupByTermCheckbox.checked;
      renderListings();
    });
    filterButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        filterButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.dataset.filter;
        fetchListings();
      });
    });
    scheduleEnabledCb.addEventListener('change', updateScheduleFieldsVisibility);
    [scheduleIntervalSel, scheduleStartSel, scheduleEndSel].forEach(el => {
      el.addEventListener('change', updateSchedulePreview);
    });
    btnSaveSchedule.addEventListener('click', saveSchedule);
    notifyEnabledCb.addEventListener('change', updateNotifyFieldsVisibility);
    btnSaveNotify.addEventListener('click', saveNotify);

    sourceTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        if (tab.dataset.source === currentSource) return;
        sourceTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentSource = tab.dataset.source;
        currentSort = DEFAULT_SORT[currentSource];
        buildSortOptions();
        collapsedGroups.clear();
        updateScrapingUI();
        fetchListings();
        fetchConfig();
      });
    });
  }

  function buildSortOptions() {
    sortSelect.innerHTML = '';
    for (const opt of SORT_OPTIONS[currentSource]) {
      const el = document.createElement('option');
      el.value = opt.value;
      el.textContent = opt.label;
      if (opt.value === currentSort) el.selected = true;
      sortSelect.appendChild(el);
    }
  }

  // --- API Calls ---
  async function fetchListings() {
    const [sort, direction] = currentSort.split(':');
    const filterNew = currentFilter === 'new';
    const showHidden = currentFilter === 'hidden';
    const params = new URLSearchParams({ sort, direction, filterNew, showHidden, source: currentSource });
    try {
      const res = await fetch(`api/listings?${params}`);
      const data = await res.json();
      listings = data.listings;
      updateNewBadge(data.newCount);
      updateHiddenBadge(data.hiddenCount);
      renderListings();
    } catch (err) {
      console.error('Failed to fetch listings:', err);
    }
  }

  async function fetchConfig() {
    try {
      const res = await fetch('api/config');
      const data = await res.json();
      searchTermsConfig = data.searchTerms;
      renderTerms(data.searchTerms);
      const lastRun = currentSource === 'dd' ? data.ddLastRun : data.lastRun;
      if (lastRun && lastRun.completed_at) {
        lastRunEl.textContent = 'Last run: ' + timeAgo(lastRun.completed_at);
      } else {
        lastRunEl.textContent = '';
      }
      if (data.schedule) {
        scheduleConfig = data.schedule;
        applyScheduleToUI(scheduleConfig);
      }
      if (data.notify) {
        notifyConfig = data.notify;
        applyNotifyToUI(notifyConfig);
      }
    } catch (err) {
      console.error('Failed to fetch config:', err);
    }
  }

  async function startScrape() {
    btnScrape.disabled = true;
    try {
      const res = await fetch('api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: currentSource }),
      });
      if (res.status === 409) {
        btnScrape.disabled = false;
        return;
      }
      if (currentSource === 'cc') ccRunning = true;
      else ddRunning = true;
      updateScrapingUI();
    } catch (err) {
      btnScrape.disabled = false;
      console.error('Failed to start scrape:', err);
    }
  }

  async function abortScrape() {
    try {
      await fetch('api/scrape/abort', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: currentSource }),
      });
    } catch (err) {
      console.error('Failed to abort:', err);
    }
  }

  async function markSeen(id, e) {
    e.stopPropagation();
    try {
      await fetch(`api/listings/${id}/seen?source=${currentSource}`, { method: 'POST' });
      await fetchListings();
    } catch (err) {
      console.error('Failed to mark seen:', err);
    }
  }

  async function markAllSeen() {
    try {
      await fetch(`api/listings/mark-all-seen?source=${currentSource}`, { method: 'POST' });
      await fetchListings();
    } catch (err) {
      console.error('Failed to mark all seen:', err);
    }
  }

  async function hideListing(id, e) {
    e.stopPropagation();
    try {
      await fetch(`api/listings/${id}/hide?source=${currentSource}`, { method: 'POST' });
      await fetchListings();
    } catch (err) {
      console.error('Failed to hide listing:', err);
    }
  }

  async function unhideListing(id, e) {
    e.stopPropagation();
    try {
      await fetch(`api/listings/${id}/unhide?source=${currentSource}`, { method: 'POST' });
      await fetchListings();
    } catch (err) {
      console.error('Failed to unhide listing:', err);
    }
  }

  async function addTerm() {
    const term = newTermInput.value.trim();
    if (!term) return;
    try {
      const res = await fetch('api/config');
      const data = await res.json();
      const terms = [...data.searchTerms, { term, max_price: null }];
      await fetch('api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ searchTerms: terms }),
      });
      newTermInput.value = '';
      await fetchConfig();
    } catch (err) {
      console.error('Failed to add term:', err);
    }
  }

  async function addByUrl() {
    const url = addUrlInput.value.trim();
    if (!url) return;
    btnAddUrl.disabled = true;
    addUrlInput.classList.remove('error', 'success');
    try {
      const res = await fetch('api/scrape/single', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, source: currentSource }),
      });
      const data = await res.json();
      if (!res.ok) {
        addUrlInput.classList.add('error');
        setTimeout(() => addUrlInput.classList.remove('error'), 2000);
        return;
      }
      addUrlInput.value = '';
      addUrlInput.classList.add('success');
      setTimeout(() => addUrlInput.classList.remove('success'), 2000);
      await fetchListings();
    } catch (err) {
      addUrlInput.classList.add('error');
      setTimeout(() => addUrlInput.classList.remove('error'), 2000);
      console.error('Failed to add listing:', err);
    } finally {
      btnAddUrl.disabled = false;
    }
  }

  async function removeTerm(term) {
    try {
      const res = await fetch('api/config');
      const data = await res.json();
      const terms = data.searchTerms.filter(t => t.term !== term);
      if (terms.length === 0) return;
      await fetch('api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ searchTerms: terms }),
      });
      await fetchConfig();
    } catch (err) {
      console.error('Failed to remove term:', err);
    }
  }

  async function updateMaxPrice(term, maxPrice) {
    try {
      await fetch('api/config/max-price', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ term, maxPrice: maxPrice || null }),
      });
      // Don't fetchConfig() here — it would rebuild the settings DOM and steal focus
      await fetchListings();
    } catch (err) {
      console.error('Failed to update max price:', err);
    }
  }

  async function toggleSiteEnabled(term, site, enabled) {
    try {
      await fetch('api/config/site-enabled', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ term, site, enabled }),
      });
    } catch (err) {
      console.error('Failed to toggle site enabled:', err);
    }
  }

  // --- Schedule ---

  function buildHourSelects() {
    const labels = [
      '12:00 am','1:00 am','2:00 am','3:00 am','4:00 am','5:00 am',
      '6:00 am','7:00 am','8:00 am','9:00 am','10:00 am','11:00 am',
      '12:00 pm','1:00 pm','2:00 pm','3:00 pm','4:00 pm','5:00 pm',
      '6:00 pm','7:00 pm','8:00 pm','9:00 pm','10:00 pm','11:00 pm',
    ];
    for (let h = 0; h < 24; h++) {
      const startOpt = document.createElement('option');
      startOpt.value = h;
      startOpt.textContent = labels[h];
      scheduleStartSel.appendChild(startOpt);

      const endOpt = document.createElement('option');
      endOpt.value = h;
      endOpt.textContent = labels[h];
      scheduleEndSel.appendChild(endOpt);
    }
  }

  function applyScheduleToUI(cfg) {
    scheduleEnabledCb.checked = cfg.enabled;
    scheduleIntervalSel.value = String(cfg.intervalHours);
    scheduleStartSel.value = String(cfg.startHour);
    scheduleEndSel.value = String(cfg.endHour);
    updateScheduleFieldsVisibility();
    updateSchedulePreview();
  }

  function updateScheduleFieldsVisibility() {
    scheduleFields.classList.toggle('hidden', !scheduleEnabledCb.checked);
  }

  function updateSchedulePreview() {
    const interval = parseInt(scheduleIntervalSel.value, 10);
    const start = parseInt(scheduleStartSel.value, 10);
    const end = parseInt(scheduleEndSel.value, 10);
    if (isNaN(interval) || isNaN(start) || isNaN(end) || end <= start) {
      schedulePreview.textContent = '';
      return;
    }
    const hours = [];
    for (let h = start; h <= end; h += interval) hours.push(h);
    if (hours.length === 0) {
      schedulePreview.textContent = 'No runs scheduled in this window.';
      return;
    }
    const labels = hours.map(formatHour).join(', ');
    schedulePreview.textContent = `Will run at: ${labels} (${hours.length}× per day)`;
  }

  async function saveSchedule() {
    const enabled = scheduleEnabledCb.checked;
    const intervalHours = parseInt(scheduleIntervalSel.value, 10);
    const startHour = parseInt(scheduleStartSel.value, 10);
    const endHour = parseInt(scheduleEndSel.value, 10);
    if (endHour <= startHour) {
      schedulePreview.textContent = 'End time must be after start time.';
      return;
    }
    try {
      btnSaveSchedule.disabled = true;
      const res = await fetch('api/config/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, intervalHours, startHour, endHour }),
      });
      if (res.ok) {
        const data = await res.json();
        scheduleConfig = data.schedule;
        updateSchedulePreview();
        btnSaveSchedule.textContent = 'Saved!';
        setTimeout(() => { btnSaveSchedule.textContent = 'Save Schedule'; }, 1500);
      }
    } catch (err) {
      console.error('Failed to save schedule:', err);
    } finally {
      btnSaveSchedule.disabled = false;
    }
  }

  function applyNotifyToUI(cfg) {
    notifyEnabledCb.checked = cfg.enabled;
    notifyServiceInput.value = cfg.service || 'persistent_notification';
    updateNotifyFieldsVisibility();
  }

  function updateNotifyFieldsVisibility() {
    notifyFields.classList.toggle('hidden', !notifyEnabledCb.checked);
  }

  async function saveNotify() {
    const enabled = notifyEnabledCb.checked;
    const service = notifyServiceInput.value.trim() || 'persistent_notification';
    try {
      btnSaveNotify.disabled = true;
      const res = await fetch('api/config/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, service }),
      });
      if (res.ok) {
        const data = await res.json();
        notifyConfig = data.notify;
        btnSaveNotify.textContent = 'Saved!';
        setTimeout(() => { btnSaveNotify.textContent = 'Save'; }, 1500);
      }
    } catch (err) {
      console.error('Failed to save notify config:', err);
    } finally {
      btnSaveNotify.disabled = false;
    }
  }

  function toggleSettings() {
    settingsPanel.classList.toggle('open');
    btnSettings.textContent = settingsPanel.classList.contains('open') ? 'Close Settings' : 'Settings';
  }

  // --- SSE ---
  function connectSSE() {
    if (eventSource) eventSource.close();
    eventSource = new EventSource('api/scrape/progress');

    eventSource.addEventListener('connected', (e) => {
      const data = JSON.parse(e.data);
      ccRunning = data.ccRunning;
      ddRunning = data.ddRunning;
      updateScrapingUI();
    });

    eventSource.addEventListener('start', (e) => {
      const data = JSON.parse(e.data);
      if (data.source === 'cc') ccRunning = true;
      else ddRunning = true;
      updateScrapingUI();
    });

    eventSource.addEventListener('progress', (e) => {
      const data = JSON.parse(e.data);
      if (data.source !== currentSource) return;
      progressText.textContent = data.message;
      if (data.percent !== undefined) {
        progressBar.style.width = data.percent + '%';
      }
    });

    eventSource.addEventListener('listing', (e) => {
      const data = JSON.parse(e.data);
      if (data.source !== currentSource) return;
      const listing = data;
      const idx = listings.findIndex(l => l.id === listing.id);
      if (idx >= 0) {
        listings[idx] = { ...listings[idx], ...listing };
      } else {
        listings.push(listing);
      }
      renderListings();
    });

    eventSource.addEventListener('complete', (e) => {
      const data = JSON.parse(e.data);
      if (data.source === 'cc') ccRunning = false;
      else ddRunning = false;
      updateScrapingUI();

      if (data.source === currentSource) {
        let msg = `Done! Found ${data.totalFound} listings (${data.newCount} new)`;
        if (data.skippedCount) msg += `, ${data.skippedCount} filtered by price`;
        progressText.textContent = msg;
        setTimeout(() => {
          if (!isCurrentSourceRunning()) {
            progressSection.classList.add('hidden');
          }
        }, 4000);
        fetchListings();
        fetchConfig();
      }
    });

    eventSource.addEventListener('error', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.source === 'cc') ccRunning = false;
        else if (data.source === 'dd') ddRunning = false;
        updateScrapingUI();
        if (data.source === currentSource) {
          progressText.textContent = data.message;
        }
      } catch {
        // SSE connection error, will auto-reconnect
      }
    });
  }

  // --- UI State ---
  function isCurrentSourceRunning() {
    return currentSource === 'cc' ? ccRunning : ddRunning;
  }

  function updateScrapingUI() {
    const active = isCurrentSourceRunning();
    btnScrape.disabled = active;
    btnScrape.textContent = active ? 'Scraping...' : 'Scrape Now';
    progressSection.classList.toggle('hidden', !active);
    if (active) {
      progressBar.style.width = '0%';
      progressText.textContent = 'Starting...';
    }
  }

  function updateNewBadge(count) {
    newBadge.textContent = count;
    newBadge.classList.toggle('hidden', count === 0);
  }

  function updateHiddenBadge(count) {
    hiddenBadge.textContent = count;
    hiddenBadge.classList.toggle('hidden', count === 0);
  }

  // --- Rendering ---
  function renderListings() {
    if (listings.length === 0) {
      listingsGrid.innerHTML = '';
      listingsGrid.appendChild(emptyState);
      emptyState.style.display = '';
      return;
    }

    emptyState.style.display = 'none';
    listingsGrid.innerHTML = '';

    if (!groupByTerm) {
      listingsGrid.classList.remove('grouped');
      for (const listing of listings) {
        listingsGrid.appendChild(createCard(listing));
      }
      return;
    }

    // Grouped view: build term -> listings map
    listingsGrid.classList.add('grouped');
    const groups = new Map();
    for (const listing of listings) {
      const terms = listing.search_term
        ? listing.search_term.split(',').map(t => t.trim())
        : ['unknown'];
      for (const term of terms) {
        if (!groups.has(term)) groups.set(term, []);
        groups.get(term).push(listing);
      }
    }

    // Sort group keys alphabetically, but put "manual" last
    const sortedKeys = Array.from(groups.keys()).sort((a, b) => {
      if (a === 'manual') return 1;
      if (b === 'manual') return -1;
      return a.localeCompare(b);
    });

    for (const term of sortedKeys) {
      const isCollapsed = collapsedGroups.has(term);
      const section = document.createElement('div');
      section.className = 'listing-group' + (isCollapsed ? ' collapsed' : '');

      const heading = document.createElement('div');
      heading.className = 'listing-group-heading';
      heading.innerHTML = `<span class="group-chevron">${isCollapsed ? '\u25B6' : '\u25BC'}</span><span class="group-term">${esc(term)}</span><span class="group-count">${groups.get(term).length}</span>`;
      heading.style.cursor = 'pointer';
      heading.addEventListener('click', () => {
        if (collapsedGroups.has(term)) {
          collapsedGroups.delete(term);
        } else {
          collapsedGroups.add(term);
        }
        renderListings();
      });
      section.appendChild(heading);

      if (!isCollapsed) {
        const grid = document.createElement('div');
        grid.className = 'listings-grid group-grid';
        for (const listing of groups.get(term)) {
          grid.appendChild(createCard(listing));
        }
        section.appendChild(grid);
      }

      listingsGrid.appendChild(section);
    }
  }

  function createCard(l) {
    const isHiddenView = currentFilter === 'hidden';
    const card = document.createElement('div');
    card.className = 'listing-card' + (l.is_new ? ' is-new' : '') + (l.is_hidden ? ' is-hidden-card' : '');
    card.addEventListener('click', () => window.open(l.url, '_blank'));

    const imageHtml = l.image_url
      ? `<img class="card-image" src="${esc(l.image_url)}" alt="${esc(l.title)}" loading="lazy" onerror="this.style.display='none'">`
      : `<div class="card-image-placeholder">No image</div>`;

    let actionsHtml = '';
    if (isHiddenView) {
      actionsHtml = `<button class="btn-card-action unhide-btn" data-id="${l.id}" title="Unhide">Show</button>`;
    } else {
      if (l.is_new) {
        actionsHtml += `<button class="btn-card-action" data-action="dismiss" data-id="${l.id}" title="Mark as seen">Dismiss</button>`;
      }
      actionsHtml += `<button class="btn-card-action hide-btn" data-action="hide" data-id="${l.id}" title="Hide this listing">Hide</button>`;
    }

    let pricesHtml;
    if (currentSource === 'dd') {
      const price = l.price != null ? formatMoney(l.price) : '-';
      pricesHtml = `
        <div class="card-prices dd-prices">
          <div class="price-item">
            <span class="price-label">Price</span>
            <span class="price-value buy-now">${price}</span>
          </div>
        </div>
      `;
    } else {
      const buyNow = l.buy_now_price != null ? formatMoney(l.buy_now_price) : '-';
      const current = l.current_price != null ? formatMoney(l.current_price) : '-';
      const minBid = l.min_bid != null ? formatMoney(l.min_bid) : '-';
      pricesHtml = `
        <div class="card-prices">
          <div class="price-item">
            <span class="price-label">Buy Now</span>
            <span class="price-value buy-now">${buyNow}</span>
          </div>
          <div class="price-item">
            <span class="price-label">Current</span>
            <span class="price-value current">${current}</span>
          </div>
          <div class="price-item">
            <span class="price-label">Min Bid</span>
            <span class="price-value">${minBid}</span>
          </div>
          <div class="price-item">
            <span class="price-label">Bids</span>
            <span class="price-value">${l.bids || 0}</span>
          </div>
        </div>
      `;
    }

    let metaHtml = '';
    if (currentSource === 'cc') {
      metaHtml = `
        <div class="card-meta">
          ${l.remaining_time ? `<span>&#9200; ${esc(l.remaining_time)}</span>` : ''}
          ${l.end_date ? `<span>Ends: ${esc(formatEndDate(l.end_date))}</span>` : ''}
        </div>
      `;
    }

    card.innerHTML = `
      ${imageHtml}
      <div class="card-body">
        <div class="card-header">
          <span class="card-title">${esc(l.title)}</span>
          ${l.is_new ? '<span class="new-tag">New</span>' : ''}
        </div>
        ${pricesHtml}
        ${metaHtml}
        <div class="card-footer">
          <span class="search-tag">${esc(l.search_term)}</span>
          <div class="card-actions">
            ${actionsHtml}
            <span class="card-link">View &rarr;</span>
          </div>
        </div>
      </div>
    `;

    // Bind action buttons
    card.querySelectorAll('.btn-card-action').forEach(btn => {
      const action = btn.dataset.action;
      const id = parseInt(btn.dataset.id, 10);
      if (action === 'dismiss') {
        btn.addEventListener('click', (e) => markSeen(id, e));
      } else if (action === 'hide') {
        btn.addEventListener('click', (e) => hideListing(id, e));
      }
    });
    const unhideBtn = card.querySelector('.unhide-btn');
    if (unhideBtn) {
      unhideBtn.addEventListener('click', (e) => unhideListing(parseInt(unhideBtn.dataset.id, 10), e));
    }

    return card;
  }

  function renderTerms(terms) {
    termsList.innerHTML = '';
    for (const t of terms) {
      const row = document.createElement('div');
      row.className = 'term-row';

      const name = document.createElement('span');
      name.className = 'term-name';
      name.textContent = t.term;

      const sitesToggles = document.createElement('div');
      sitesToggles.className = 'term-sites';
      sitesToggles.innerHTML = `
        <label class="site-toggle" title="Search Cash Converters">
          <input type="checkbox" data-term="${esc(t.term)}" data-site="cc" ${t.cc_enabled ? 'checked' : ''}>
          <span>CC</span>
        </label>
        <label class="site-toggle" title="Search Dollar Dealers">
          <input type="checkbox" data-term="${esc(t.term)}" data-site="dd" ${t.dd_enabled ? 'checked' : ''}>
          <span>DD</span>
        </label>
      `;
      sitesToggles.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', () => {
          toggleSiteEnabled(cb.dataset.term, cb.dataset.site, cb.checked);
        });
      });

      const priceBox = document.createElement('div');
      priceBox.className = 'term-max-price';
      priceBox.innerHTML = `
        <span>Max $</span>
        <input type="number" step="1" min="0" placeholder="No limit" value="${t.max_price != null ? t.max_price : ''}" data-term="${esc(t.term)}">
      `;
      const input = priceBox.querySelector('input');
      let debounceTimer;
      input.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          const val = input.value ? parseFloat(input.value) : null;
          updateMaxPrice(t.term, val);
        }, 600);
      });

      const removeBtn = document.createElement('button');
      removeBtn.className = 'term-remove';
      removeBtn.innerHTML = '&times;';
      removeBtn.title = 'Remove';
      removeBtn.addEventListener('click', () => removeTerm(t.term));

      row.appendChild(name);
      row.appendChild(sitesToggles);
      row.appendChild(priceBox);
      row.appendChild(removeBtn);
      termsList.appendChild(row);
    }
  }

  // --- Helpers ---
  function formatMoney(val) {
    if (val == null) return '-';
    return '$' + Number(val).toFixed(2);
  }

  function formatEndDate(str) {
    if (!str) return '';
    const parts = str.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}:\d{2})/);
    if (parts) {
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return `${months[parseInt(parts[1], 10) - 1]} ${parseInt(parts[2], 10)}, ${parts[3]} ${parts[4]}`;
    }
    return str;
  }

  function formatHour(h) {
    if (h === 0) return '12:00 am';
    if (h === 12) return '12:00 pm';
    return h < 12 ? `${h}:00 am` : `${h - 12}:00 pm`;
  }

  function timeAgo(isoStr) {
    if (!isoStr) return '';
    const d = new Date(isoStr + 'Z');
    const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
    const days = Math.floor(hours / 24);
    return days === 1 ? '1 day ago' : `${days} days ago`;
  }

  function esc(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // Refresh relative timestamps every 60s
  setInterval(() => fetchConfig(), 60000);

  // --- Start ---
  init();
})();
