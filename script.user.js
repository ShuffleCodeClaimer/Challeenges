// ==UserScript==
// @name         Stake Community Bet Scraper (FAST)
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  Scrape bet IDs from StakeCommunity posts and look them up on Stake — batched GraphQL turbo edition
// @author       You
// @match        *://stake.com/*
// @match        *://*.stake.com/*
// @match        *://playstake.club/*
// @match        *://*.playstake.club/*
// @match        *://stake.ac/*
// @match        *://*.stake.ac/*
// @match        *://stake.bet/*
// @match        *://*.stake.bet/*
// @match        *://stake.bz/*
// @match        *://*.stake.bz/*
// @match        *://stake.ceo/*
// @match        *://*.stake.ceo/*
// @match        *://stake.games/*
// @match        *://*.stake.games/*
// @match        *://stake.jp/*
// @match        *://*.stake.jp/*
// @match        *://stake.krd/*
// @match        *://*.stake.krd/*
// @match        *://stake.mba/*
// @match        *://*.stake.mba/*
// @match        *://stake.pet/*
// @match        *://*.stake.pet/*
// @match        *://staketr.com/*
// @match        *://*.staketr.com/*
// @match        *://stake1001.com/*
// @match        *://*.stake1001.com/*
// @match        *://stake1002.com/*
// @match        *://*.stake1002.com/*
// @match        *://stake1003.com/*
// @match        *://*.stake1003.com/*
// @match        *://stake1017.com/*
// @match        *://*.stake1017.com/*
// @match        *://stake1022.com/*
// @match        *://*.stake1022.com/*
// @match        *://stake1039.com/*
// @match        *://*.stake1039.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      stakecommunity.com
// @connect      stake.com
// @connect      playstake.club
// @connect      stake.ac
// @connect      stake.bet
// @connect      stake.bz
// @connect      stake.ceo
// @connect      stake.games
// @connect      stake.jp
// @connect      stake.krd
// @connect      stake.mba
// @connect      stake.pet
// @connect      staketr.com
// @connect      stake1001.com
// @connect      stake1002.com
// @connect      stake1003.com
// @connect      stake1017.com
// @connect      stake1022.com
// @connect      stake1039.com
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ─── Tuning ───────────────────────────────────────────────────────────────
    // How many community pages to fetch simultaneously
    const PAGE_CONCURRENCY = 25;
    // How many bets to cram into one batched GraphQL request (aliases trick)
    const BETS_PER_BATCH   = 25;
    // How many batched requests to fire simultaneously
    const BATCH_CONCURRENCY = 10;

    // ─── Helpers ──────────────────────────────────────────────────────────────

    function getSessionToken() {
        const m = document.cookie.match(/(?:^|;\s*)session=([^;]+)/);
        return m ? m[1] : null;
    }

    // Throttled parallel map — runs fn over items with at most `concurrency` in-flight
    async function pMap(items, fn, concurrency) {
        const results = new Array(items.length);
        let idx = 0;
        async function worker() {
            while (idx < items.length) {
                const i = idx++;
                try   { results[i] = { status: 'fulfilled', value: await fn(items[i], i) }; }
                catch (e) { results[i] = { status: 'rejected', reason: e }; }
            }
        }
        const workers = [];
        for (let w = 0; w < Math.min(concurrency, items.length); w++) workers.push(worker());
        await Promise.all(workers);
        return results;
    }

    function gmFetch(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                anonymous: false,
                headers: {
                    'User-Agent': navigator.userAgent,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache',
                    'Referer': 'https://stakecommunity.com/',
                },
                onload: r => {
                    if (r.status === 0 || (r.status >= 400 && r.status < 600)) {
                        reject(new Error(`HTTP ${r.status} for ${url}`));
                    } else {
                        resolve(r.responseText);
                    }
                },
                onerror:   () => reject(new Error('Network error: ' + url)),
                ontimeout: () => reject(new Error('Timeout: ' + url)),
                timeout: 20000,
            });
        });
    }

    function stakePost(body) {
        const token  = getSessionToken();
        const origin = location.origin;
        return fetch(`${origin}/_api/graphql`, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'accept': '*/*',
                'content-type': 'application/json',
                'x-language': 'en',
                'x-operation-name': body.operationName || 'BatchBetLookup',
                'x-operation-type': 'query',
                ...(token ? { 'x-access-token': token } : {}),
            },
            body: JSON.stringify(body),
        }).then(r => r.json());
    }

    // ─── Batched GraphQL ──────────────────────────────────────────────────────
    //
    // Instead of one request per bet, we alias N bets inside a single query:
    //
    //   query BatchBetLookup {
    //     b0: bet(iid: "house:123") { ...BetFragment }
    //     b1: bet(iid: "house:456") { ...BetFragment }
    //     ...
    //   }
    //
    // This cuts API round-trips by up to BETS_PER_BATCH times.

    const BET_FRAGMENT = `
fragment BetFragment on Bet {
  id iid type scope
  game { name icon slug groupGames { group { slug } } }
  bet {
    ... on SportsbookXMultiBet { id amount active currency payoutMultiplier payout updatedAt createdAt user { id name } }
    ... on CasinoBet           { id active payoutMultiplier amountMultiplier amount payout updatedAt createdAt currency user { id name preferenceHideBets } }
    ... on EvolutionBet        { id active payoutMultiplier amount payout createdAt currency user { id name preferenceHideBets } }
    ... on MultiplayerCrashBet { id active payoutMultiplier amount payout updatedAt createdAt currency user { id name preferenceHideBets } }
    ... on MultiplayerSlideBet { id active payoutMultiplier amount payout updatedAt createdAt currency user { id name preferenceHideBets } }
    ... on SoftswissBet        { id active payoutMultiplier amount payout updatedAt createdAt currency user { id name preferenceHideBets } }
    ... on ThirdPartyBet       { id active payoutMultiplier amount payout updatedAt createdAt currency }
    ... on SportBet            { id active payoutMultiplier amount payout updatedAt createdAt currency user { id name preferenceHideBets } }
    ... on SwishBet            { id active payoutMultiplier amount payout updatedAt createdAt currency user { id name preferenceHideBets } }
    ... on RacingBet           { id active payoutMultiplier amount payout updatedAt createdAt currency }
  }
}`;

    // Build and fire one batched request for up to BETS_PER_BATCH iids
    async function fetchBetBatch(iids) {
        const aliases = iids
            .map((iid, i) => `b${i}: bet(iid: ${JSON.stringify(iid)}) { ...BetFragment }`)
            .join('\n    ');

        const query = `query BatchBetLookup {\n    ${aliases}\n}\n${BET_FRAGMENT}`;

        const data = await stakePost({ query, operationName: 'BatchBetLookup' });
        return data?.data || {};
    }

    const CURRENCY_QUERY = `
query CurrencyConfiguration($isAcp: Boolean!) {
  currencyConfiguration(isAcp: $isAcp) {
    baseRates { currency baseRate }
  }
}`;

    // ─── Scraper ──────────────────────────────────────────────────────────────

    const SCOPE_MAP = { casino: 'house' };

    function normaliseIid(iid) {
        const [scope, num] = iid.split(':');
        return (SCOPE_MAP[scope.toLowerCase()] || scope.toLowerCase()) + ':' + num;
    }

    function extractBetIds(html) {
        const seen = new Set();
        const urlRe  = /[?&]iid=([^&\s"'<>\]]+)/gi;
        const textRe = /\b(casino|house|sports|sport|evolution|softswiss|swish|racing):(\d{6,})\b/gi;
        let m;
        while ((m = urlRe.exec(html))  !== null) {
            const raw = decodeURIComponent(m[1]);
            if (/^[a-z]+:\d{6,}$/.test(raw)) seen.add(normaliseIid(raw));
        }
        while ((m = textRe.exec(html)) !== null) seen.add(normaliseIid(m[1] + ':' + m[2]));
        return [...seen];
    }

    function isCloudflareChallenge(html) {
        return html.includes('cf-browser-verification') ||
               html.includes('cf_captcha_kind') ||
               html.includes('Just a moment') ||
               html.includes('Enable JavaScript and cookies to continue') ||
               (html.length < 5000 && html.includes('cloudflare'));
    }

    // Pure-regex page count — no DOM parsing needed
    function getTotalPages(html) {
        const dpRe = /data-page="(\d+)"/g;
        let max = 1, m;
        while ((m = dpRe.exec(html)) !== null) {
            const n = parseInt(m[1], 10);
            if (n > max) max = n;
        }
        if (max > 1) return max;
        const pm = html.match(/Page \d+ of (\d+)/i);
        return pm ? parseInt(pm[1], 10) : 1;
    }

    function buildPageUrl(baseUrl, page) {
        const url = new URL(baseUrl);
        if (page === 1) return url.toString();
        let path = url.pathname.replace(/\/page\/\d+\/?$/, '').replace(/\/$/, '');
        url.pathname = `${path}/page/${page}/`;
        return url.toString();
    }

    // Streams bet IDs as soon as each page finishes — calls onIds(newIds[]) for
    // every page, plus onProgress(msg). Returns the final unique-ID set.
    async function scrapeAllBetIdsStreaming(topicUrl, onIds, onProgress) {
        onProgress('Fetching page 1…');
        const firstHtml = await gmFetch(topicUrl);

        if (isCloudflareChallenge(firstHtml)) {
            throw new Error(
                'StakeCommunity is behind a Cloudflare challenge. ' +
                'Please open stakecommunity.com in a tab, pass the challenge, then try again.'
            );
        }

        const totalPages = getTotalPages(firstHtml);
        onProgress(`Found ${totalPages} page(s) — fetching all in parallel…`);

        const seen = new Set();
        const firstIds = extractBetIds(firstHtml).filter(id => !seen.has(id));
        firstIds.forEach(id => seen.add(id));
        if (firstIds.length) onIds(firstIds);

        if (totalPages > 1) {
            const remaining = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
            let fetched = 1;
            await pMap(remaining, async (page) => {
                try {
                    const html = await gmFetch(buildPageUrl(topicUrl, page));
                    if (!isCloudflareChallenge(html)) {
                        const newIds = extractBetIds(html).filter(id => !seen.has(id));
                        newIds.forEach(id => seen.add(id));
                        if (newIds.length) onIds(newIds);
                    }
                } catch (e) {
                    console.warn('Failed page', page, e);
                }
                fetched++;
                onProgress(`Fetched ${fetched}/${totalPages} pages — ${seen.size} IDs found…`);
            }, PAGE_CONCURRENCY);
        }

        return [...seen];
    }

    // ─── State ────────────────────────────────────────────────────────────────

    let currencyRates = {};
    let allResults    = [];
    let filteredResults = [];
    let isLoading     = false;

    async function loadCurrencyRates() {
        try {
            const data = await stakePost({ query: CURRENCY_QUERY, variables: { isAcp: false }, operationName: 'CurrencyConfiguration' });
            const rates = data?.data?.currencyConfiguration?.baseRates || [];
            rates.forEach(r => { currencyRates[r.currency.toLowerCase()] = r.baseRate; });
        } catch (e) {
            console.warn('Could not load currency rates', e);
        }
    }

    function toUSD(amount, currency) {
        const rate = currencyRates[currency?.toLowerCase()];
        return (!rate || !amount) ? null : amount * rate;
    }

    function fmtUSD(val) {
        return (val == null) ? '—' : '$' + val.toFixed(2);
    }

    function fmtMult(val) {
        return (!val && val !== 0) ? '—' : val.toFixed(2) + 'x';
    }

    // ─── Styles ───────────────────────────────────────────────────────────────

    GM_addStyle(`
        #sc-fab {
            position: fixed; bottom: 24px; right: 24px; z-index: 999999;
            width: 52px; height: 52px; border-radius: 50%;
            background: linear-gradient(135deg, #00d4ff, #7b2fff);
            color: #fff; font-size: 22px; display: flex;
            align-items: center; justify-content: center;
            cursor: pointer; box-shadow: 0 4px 20px rgba(0,0,0,0.5);
            border: none; transition: transform 0.2s; user-select: none;
        }
        #sc-fab:hover { transform: scale(1.1); }

        #sc-overlay {
            display: none; position: fixed; inset: 0; z-index: 1000000;
            background: rgba(0,0,0,0.72); backdrop-filter: blur(4px);
            align-items: center; justify-content: center;
        }
        #sc-overlay.open { display: flex; }

        #sc-modal {
            background: #1a1d2e; border: 1px solid #2e3255; border-radius: 16px;
            width: 92vw; max-width: 1100px; max-height: 90vh;
            display: flex; flex-direction: column; overflow: hidden;
            box-shadow: 0 20px 60px rgba(0,0,0,0.8);
            color: #e0e6ff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        }

        #sc-header {
            display: flex; align-items: center; justify-content: space-between;
            padding: 18px 22px; border-bottom: 1px solid #2e3255;
            background: #131626; flex-shrink: 0;
        }
        #sc-header h2 { margin: 0; font-size: 16px; font-weight: 700; color: #fff; letter-spacing: 0.3px; }
        #sc-close { background: none; border: none; color: #888; font-size: 20px; cursor: pointer; line-height: 1; padding: 4px 8px; border-radius: 6px; }
        #sc-close:hover { color: #fff; background: #2e3255; }

        #sc-input-row {
            display: flex; gap: 10px; padding: 16px 22px;
            border-bottom: 1px solid #2e3255; flex-shrink: 0; background: #161929;
        }
        #sc-url-input {
            flex: 1; background: #0e1120; border: 1px solid #2e3255; border-radius: 8px;
            color: #e0e6ff; padding: 10px 14px; font-size: 13px; outline: none; transition: border-color 0.2s;
        }
        #sc-url-input:focus { border-color: #7b2fff; }
        #sc-url-input::placeholder { color: #4a5080; }

        #sc-go-btn {
            background: linear-gradient(135deg, #7b2fff, #00d4ff); border: none;
            border-radius: 8px; color: #fff; font-weight: 700; font-size: 13px;
            padding: 10px 20px; cursor: pointer; white-space: nowrap; transition: opacity 0.2s;
        }
        #sc-go-btn:hover { opacity: 0.85; }
        #sc-go-btn:disabled { opacity: 0.4; cursor: not-allowed; }

        #sc-progress-bar { height: 2px; background: linear-gradient(90deg, #7b2fff, #00d4ff); width: 0%; transition: width 0.3s; flex-shrink: 0; }

        #sc-status {
            padding: 8px 22px; font-size: 12px; color: #7b87c0; min-height: 28px;
            border-bottom: 1px solid #2e3255; flex-shrink: 0; background: #131626;
        }

        #sc-filter-row {
            display: flex; gap: 10px; padding: 12px 22px; border-bottom: 1px solid #2e3255;
            flex-shrink: 0; background: #161929; flex-wrap: wrap; align-items: center;
        }
        #sc-filter-row label { font-size: 12px; color: #7b87c0; white-space: nowrap; }
        .sc-filter-select {
            background: #0e1120; border: 1px solid #2e3255; border-radius: 6px;
            color: #e0e6ff; padding: 6px 10px; font-size: 12px; outline: none; cursor: pointer;
        }
        .sc-filter-select:focus { border-color: #7b2fff; }
        #sc-min-amount, #sc-min-mult {
            background: #0e1120; border: 1px solid #2e3255; border-radius: 6px;
            color: #e0e6ff; padding: 6px 10px; font-size: 12px; outline: none;
        }
        #sc-min-amount { width: 110px; } #sc-min-mult { width: 90px; }
        #sc-min-amount::placeholder, #sc-min-mult::placeholder { color: #4a5080; }
        #sc-after-date {
            background: #0e1120; border: 1px solid #2e3255; border-radius: 6px;
            color: #e0e6ff; padding: 6px 10px; font-size: 12px; outline: none;
            cursor: pointer; color-scheme: dark;
        }
        #sc-after-date:focus { border-color: #7b2fff; }
        #sc-after-date.active { border-color: #00d4ff; background: #0a1a2a; }
        #sc-after-clear {
            background: #2e3255; border: none; border-radius: 5px; color: #e0e6ff;
            font-size: 11px; padding: 4px 8px; cursor: pointer; margin-left: -4px;
        }
        #sc-after-clear:hover { background: #ff6b6b; color: #fff; }
        .sc-time { font-size: 11px; color: #8892b0; white-space: nowrap; }
        #sc-result-count { margin-left: auto; font-size: 12px; color: #4a5080; }

        #sc-table-wrap { overflow-y: auto; flex: 1; }
        #sc-table { width: 100%; border-collapse: collapse; font-size: 13px; }
        #sc-table thead th {
            position: sticky; top: 0; background: #131626; color: #7b87c0;
            font-weight: 600; text-align: left; padding: 10px 14px;
            border-bottom: 1px solid #2e3255; white-space: nowrap; cursor: pointer; user-select: none;
        }
        #sc-table thead th:hover { color: #e0e6ff; }
        #sc-table thead th .sort-icon { margin-left: 4px; opacity: 0.5; }
        #sc-table thead th.sorted .sort-icon { opacity: 1; color: #7b2fff; }
        #sc-table tbody tr { border-bottom: 1px solid #1e2240; transition: background 0.15s; }
        #sc-table tbody tr:hover { background: #1e2240; }
        #sc-table tbody td { padding: 10px 14px; vertical-align: middle; }

        .sc-name { font-weight: 600; color: #fff; }
        .sc-game { display: inline-flex; align-items: center; gap: 6px; background: #0e1120; border-radius: 6px; padding: 3px 8px; font-size: 12px; color: #a0aef0; }
        .sc-amount { font-weight: 700; color: #00d4aa; }
        .sc-mult { color: #ffb347; font-weight: 600; }
        .sc-payout { color: #7b87c0; }
        .sc-currency { font-size: 10px; text-transform: uppercase; color: #4a5080; margin-left: 3px; }
        .sc-iid-link { font-size: 11px; color: #7b2fff; text-decoration: none; font-family: monospace; }
        .sc-iid-link:hover { text-decoration: underline; }
        #sc-empty { text-align: center; padding: 60px 20px; color: #4a5080; font-size: 14px; }
    `);

    // ─── UI ───────────────────────────────────────────────────────────────────

    const overlay = document.createElement('div');
    overlay.id = 'sc-overlay';
    overlay.innerHTML = `
        <div id="sc-modal">
            <div id="sc-header">
                <h2>🎰 Stake Community Bet Scraper</h2>
                <button id="sc-close">✕</button>
            </div>
            <div id="sc-input-row">
                <input id="sc-url-input" type="text" placeholder="Paste StakeCommunity topic URL…" />
                <button id="sc-go-btn">Scrape &amp; Lookup</button>
            </div>
            <div id="sc-progress-bar"></div>
            <div id="sc-status">Ready. Paste a topic link above and click Scrape &amp; Lookup.</div>
            <div id="sc-filter-row" style="display:none">
                <label>Sort by:</label>
                <select class="sc-filter-select" id="sc-sort-select">
                    <option value="amount_desc">Bet Amount (High→Low)</option>
                    <option value="amount_asc">Bet Amount (Low→High)</option>
                    <option value="mult_desc">Multiplier (High→Low)</option>
                    <option value="mult_asc">Multiplier (Low→High)</option>
                    <option value="payout_desc">Payout (High→Low)</option>
                    <option value="time_desc">Time (Newest first)</option>
                    <option value="time_asc">Time (Oldest first)</option>
                </select>
                <label>Min bet ($):</label>
                <input id="sc-min-amount" type="number" min="0" step="0.01" placeholder="0.00" />
                <label>Min mult:</label>
                <input id="sc-min-mult" type="number" min="0" step="0.01" placeholder="0.00" />
                <label>Game:</label>
                <select class="sc-filter-select" id="sc-game-filter">
                    <option value="">All Games</option>
                </select>
                <label>After (UTC):</label>
                <input id="sc-after-date" type="datetime-local" />
                <button id="sc-after-clear" style="display:none">✕</button>
                <span id="sc-result-count"></span>
            </div>
            <div id="sc-table-wrap">
                <div id="sc-empty">No results yet.</div>
                <table id="sc-table" style="display:none">
                    <thead><tr>
                        <th data-col="user">Player <span class="sort-icon">↕</span></th>
                        <th data-col="game">Game <span class="sort-icon">↕</span></th>
                        <th data-col="amount">Bet (USD) <span class="sort-icon">↕</span></th>
                        <th data-col="mult">Multiplier <span class="sort-icon">↕</span></th>
                        <th data-col="payout">Payout (USD) <span class="sort-icon">↕</span></th>
                        <th data-col="time">Updated At (UTC) <span class="sort-icon">↕</span></th>
                        <th>Bet ID</th>
                    </tr></thead>
                    <tbody id="sc-tbody"></tbody>
                </table>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    const fab = document.createElement('button');
    fab.id = 'sc-fab';
    fab.title = 'Stake Community Scraper';
    fab.textContent = '🔍';
    document.body.appendChild(fab);

    // ─── UI wiring ────────────────────────────────────────────────────────────

    const $overlay     = document.getElementById('sc-overlay');
    const $close       = document.getElementById('sc-close');
    const $goBtn       = document.getElementById('sc-go-btn');
    const $urlInput    = document.getElementById('sc-url-input');
    const $status      = document.getElementById('sc-status');
    const $progressBar = document.getElementById('sc-progress-bar');
    const $filterRow   = document.getElementById('sc-filter-row');
    const $sortSelect  = document.getElementById('sc-sort-select');
    const $minAmount   = document.getElementById('sc-min-amount');
    const $minMult     = document.getElementById('sc-min-mult');
    const $gameFilter  = document.getElementById('sc-game-filter');
    const $afterDate   = document.getElementById('sc-after-date');
    const $afterClear  = document.getElementById('sc-after-clear');
    const $resultCount = document.getElementById('sc-result-count');
    const $table       = document.getElementById('sc-table');
    const $tbody       = document.getElementById('sc-tbody');
    const $empty       = document.getElementById('sc-empty');

    let sortCol = 'amount', sortDir = 'desc';

    fab.addEventListener('click', () => $overlay.classList.add('open'));
    $close.addEventListener('click', () => $overlay.classList.remove('open'));
    $overlay.addEventListener('click', e => { if (e.target === $overlay) $overlay.classList.remove('open'); });

    document.querySelectorAll('#sc-table thead th[data-col]').forEach(th => {
        th.addEventListener('click', () => {
            const col = th.dataset.col;
            sortDir = (sortCol === col && sortDir === 'desc') ? 'asc' : 'desc';
            sortCol = col;
            document.querySelectorAll('#sc-table thead th').forEach(h => h.classList.remove('sorted'));
            th.classList.add('sorted');
            th.querySelector('.sort-icon').textContent = sortDir === 'desc' ? '↓' : '↑';
            renderTable();
        });
    });

    $sortSelect.addEventListener('change', () => {
        [sortCol, sortDir] = $sortSelect.value.split('_');
        renderTable();
    });
    $minAmount.addEventListener('input',  renderTable);
    $minMult.addEventListener('input',    renderTable);
    $gameFilter.addEventListener('change', renderTable);

    function onAfterChange() {
        $afterDate.classList.toggle('active', !!$afterDate.value);
        $afterClear.style.display = $afterDate.value ? 'inline-block' : 'none';
        renderTable();
    }
    $afterDate.addEventListener('change', onAfterChange);
    $afterDate.addEventListener('input',  onAfterChange);
    $afterClear.addEventListener('click', () => { $afterDate.value = ''; onAfterChange(); });

    function setStatus(msg, pct) {
        $status.textContent = msg;
        if (pct !== undefined) $progressBar.style.width = pct + '%';
    }

    function populateGameFilter() {
        const games   = [...new Set(allResults.map(r => r.gameName).filter(Boolean))].sort();
        const current = $gameFilter.value;
        $gameFilter.innerHTML = '<option value="">All Games</option>';
        games.forEach(g => {
            const o = document.createElement('option');
            o.value = g; o.textContent = g;
            if (g === current) o.selected = true;
            $gameFilter.appendChild(o);
        });
    }

    function applyFilters() {
        let res = [...allResults];
        const minAmt  = parseFloat($minAmount.value) || 0;
        const minMult = parseFloat($minMult.value)   || 0;
        const game    = $gameFilter.value;
        const afterTs = $afterDate.value ? new Date($afterDate.value + 'Z').getTime() : null;

        if (minAmt  > 0)      res = res.filter(r => (r.amountUSD         || 0) >= minAmt);
        if (minMult > 0)      res = res.filter(r => (r.payoutMultiplier   || 0) >= minMult);
        if (game)             res = res.filter(r => r.gameName === game);
        if (afterTs !== null) res = res.filter(r => r.updatedAt !== null && r.updatedAt >= afterTs);

        res.sort((a, b) => {
            let av, bv;
            if      (sortCol === 'amount') { av = a.amountUSD || 0;          bv = b.amountUSD || 0; }
            else if (sortCol === 'mult')   { av = a.payoutMultiplier || 0;   bv = b.payoutMultiplier || 0; }
            else if (sortCol === 'payout') { av = a.payoutUSD || 0;          bv = b.payoutUSD || 0; }
            else if (sortCol === 'time')   { av = a.updatedAt || 0;          bv = b.updatedAt || 0; }
            else if (sortCol === 'user')   { return sortDir === 'asc' ? (a.userName||'').localeCompare(b.userName||'') : (b.userName||'').localeCompare(a.userName||''); }
            else if (sortCol === 'game')   { return sortDir === 'asc' ? (a.gameName||'').localeCompare(b.gameName||'') : (b.gameName||'').localeCompare(a.gameName||''); }
            else { av = 0; bv = 0; }
            return sortDir === 'asc' ? av - bv : bv - av;
        });
        return res;
    }

    function escHtml(s) {
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // One innerHTML set for the entire table — fastest possible DOM update
    function renderTable() {
        if (!allResults.length) {
            $table.style.display = 'none';
            $empty.style.display = 'block';
            $filterRow.style.display = 'none';
            return;
        }
        filteredResults = applyFilters();
        $resultCount.textContent = `${filteredResults.length} / ${allResults.length} bets`;
        $filterRow.style.display = 'flex';
        $empty.style.display = 'none';
        $table.style.display = 'table';

        $tbody.innerHTML = filteredResults.map(r => {
            const iid    = r.iid || r.rawId;
            const betUrl = `${location.origin}/?iid=${encodeURIComponent(iid)}&modal=bet`;
            const short  = iid.length > 24 ? iid.slice(0, 24) + '…' : iid;
            const time   = r.updatedAt ? new Date(r.updatedAt).toUTCString().replace(/:\d\d GMT$/, ' UTC') : '—';
            return `<tr>
                <td class="sc-name">${escHtml(r.userName || 'Hidden')}</td>
                <td><span class="sc-game">${escHtml(r.gameName || r.gameSlug || '—')}</span></td>
                <td class="sc-amount">${fmtUSD(r.amountUSD)}<span class="sc-currency">${r.currency||''}</span></td>
                <td class="sc-mult">${fmtMult(r.payoutMultiplier)}</td>
                <td class="sc-payout">${fmtUSD(r.payoutUSD)}</td>
                <td class="sc-time">${time}</td>
                <td><a class="sc-iid-link" href="${betUrl}" target="_blank" title="${escHtml(iid)}">${escHtml(short)}</a></td>
            </tr>`;
        }).join('');
    }

    // ─── Main flow ────────────────────────────────────────────────────────────

    $goBtn.addEventListener('click', async () => {
        const url = $urlInput.value.trim();
        if (!url || !url.includes('stakecommunity.com')) {
            setStatus('⚠ Please enter a valid StakeCommunity topic URL.');
            return;
        }
        if (isLoading) return;

        isLoading = true;
        $goBtn.disabled = true;
        allResults = []; filteredResults = [];
        $tbody.innerHTML = '';
        $table.style.display = 'none';
        $empty.style.display = 'block';
        $empty.textContent = 'Loading…';
        $filterRow.style.display = 'none';
        $progressBar.style.width = '0%';

        try {
            setStatus('Loading currency rates…', 5);
            // Don't block on currency rates — load them in parallel with scraping
            const ratesPromise = loadCurrencyRates();

            // ── Pipelined: bet API batches start firing as soon as page 1 is parsed ─
            let totalQueued = 0;
            let totalDone   = 0;
            let scrapeDone  = false;
            const pendingIds = [];
            const allBatchPromises = [];

            // simple counting semaphore to cap in-flight batched requests
            let inflight = 0;
            const waiters = [];
            function acquire() {
                if (inflight < BATCH_CONCURRENCY) { inflight++; return Promise.resolve(); }
                return new Promise(res => waiters.push(res));
            }
            function release() {
                inflight--;
                const w = waiters.shift();
                if (w) { inflight++; w(); }
            }

            async function runBatch(batch) {
                await acquire();
                try {
                    // Make sure currency rates are loaded BEFORE we compute USD —
                    // they were kicked off in parallel; this awaits the same promise
                    // so we don't silently store null USD values.
                    await ratesPromise;

                    let batchData = {};
                    try { batchData = await fetchBetBatch(batch); }
                    catch (e) { console.warn('Batch failed:', e); }

                    batch.forEach((rawId, i) => {
                        const bet = batchData[`b${i}`];
                        totalDone++;
                        if (!bet) return;
                        const inner = bet.bet;
                        if (!inner) return;

                        const amountRaw    = inner.amount || 0;
                        const payoutRaw    = inner.payout || 0;
                        const currency     = inner.currency || '';
                        const updatedAtRaw = inner.updatedAt || inner.createdAt || null;

                        allResults.push({
                            rawId,
                            iid:             bet.iid,
                            gameName:        bet.game?.name || '',
                            gameSlug:        bet.game?.slug || '',
                            userName:        inner.user?.name || '',
                            currency,
                            amount:          amountRaw,
                            amountUSD:       toUSD(amountRaw, currency),
                            payout:          payoutRaw,
                            payoutUSD:       toUSD(payoutRaw, currency),
                            payoutMultiplier: inner.payoutMultiplier || 0,
                            updatedAt:       updatedAtRaw ? new Date(updatedAtRaw).getTime() : null,
                        });
                    });

                    const known = scrapeDone ? totalQueued : Math.max(totalQueued, totalDone);
                    const pct   = scrapeDone
                        ? Math.min(95, 20 + Math.round((totalDone / Math.max(1, totalQueued)) * 75))
                        : Math.min(60, 20 + Math.round((totalDone / Math.max(1, known)) * 30));
                    setStatus(`Looked up ${totalDone}/${known} bets…`, pct);
                } finally {
                    release();
                }
            }

            function flushPending(force) {
                while (pendingIds.length >= BETS_PER_BATCH || (force && pendingIds.length > 0)) {
                    const batch = pendingIds.splice(0, BETS_PER_BATCH);
                    allBatchPromises.push(runBatch(batch));
                }
            }

            // ── Step 1: stream IDs from community pages, fire bet batches mid-flight ─
            await scrapeAllBetIdsStreaming(
                url,
                (newIds) => {
                    totalQueued += newIds.length;
                    pendingIds.push(...newIds);
                    flushPending(false);
                },
                msg => setStatus(msg, 15)
            );
            scrapeDone = true;

            if (totalQueued === 0) {
                setStatus('⚠ No bet IDs found. Check the URL and try again.');
                $empty.textContent = 'No bet IDs found in that topic.';
                return;
            }

            // flush any leftovers and wait for all in-flight batches to finish
            flushPending(true);
            await Promise.all(allBatchPromises);
            await ratesPromise;

            populateGameFilter();
            renderTable();
            setStatus(`Done! Loaded ${allResults.length} bets from ${totalQueued} IDs.`, 100);

            if (!allResults.length) {
                $empty.textContent = 'No bets loaded. You may need to be logged in to Stake.';
                $empty.style.display = 'block';
            }

        } catch (err) {
            console.error('Scraper error:', err);
            setStatus('❌ Error: ' + err.message);
            $empty.textContent = 'An error occurred. Check the console for details.';
            $empty.style.display = 'block';
        } finally {
            isLoading = false;
            $goBtn.disabled = false;
        }
    });

    $urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') $goBtn.click(); });

})();
