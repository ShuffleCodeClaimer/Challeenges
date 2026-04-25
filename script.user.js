// ==UserScript==
// @name         Stake Challenge Hunter
// @namespace    https://stake.ac/casino/challenges
// @version      1.3.0
// @description  Finds the best challenges to hunt on Stake — small bets, low multipliers, big prizes. Floating overlay with filters and scoring.
// @author       You
// @match        https://stake.ac/casino/challenges*
// @match        https://www.stake.ac/casino/challenges*
// @match        https://stake.com/casino/challenges*
// @match        https://www.stake.com/casino/challenges*
// @match        https://stake.us/casino/challenges*
// @match        https://www.stake.us/casino/challenges*
// @grant        GM_addStyle
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const SCRIPT_ID = 'stake-challenge-hunter';
  const FETCH_LIMIT = 24;
  const MAX_PAGES = 999;

  const CHALLENGE_FIELDS = `
    id
    active
    award
    currency
    minBetUsd
    betCurrency
    targetMultiplier
    claimCount
    claimMax
    startAt
    expireAt
    game {
      id
      name
      slug
      thumbnailUrl
    }
  `;

  const GQL_QUERY_AC = `
    query ChallengeList($limit: Int!, $offset: Int!, $sort: ChallengeSort!, $direction: ChallengeSortDirection, $type: ChallengeFilterType!, $count: ChallengeCountType!) {
      user {
        id
        challengeCount(type: $count)
        challengeList(limit: $limit, offset: $offset, sort: $sort, direction: $direction, type: $type) {
          ${CHALLENGE_FIELDS}
        }
      }
    }
  `;

  const GQL_QUERY_US = `
    query ChallengePublicList($limit: Int!, $offset: Int!, $sort: ChallengeSort!, $direction: ChallengeSortDirection) {
      challengeUnauthenticatedUserCount
      challengeUnauthenticatedUserList(limit: $limit, offset: $offset, sort: $sort, direction: $direction) {
        ${CHALLENGE_FIELDS}
      }
    }
  `;

  function isStakeUS() {
    return /stake\.us/i.test(location.hostname);
  }

  function getAccessToken() {
    try {
      const uw = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

      const cookieStr = uw.document.cookie;
      const sessionMatch = cookieStr.match(/(?:^|;\s*)session=([^;]+)/);
      if (sessionMatch && sessionMatch[1].length > 30) return decodeURIComponent(sessionMatch[1]);

      try {
        const ls = uw.localStorage;
        const candidates = ['session', 'token', 'accessToken', 'access_token', 'authToken', 'auth_token', 'stake_session'];
        for (const key of candidates) {
          const val = ls.getItem(key);
          if (val && val.length > 30 && !val.startsWith('{') && !val.startsWith('[')) return val;
        }
        for (let i = 0; i < ls.length; i++) {
          const k = ls.key(i);
          if (/(session|token|auth)/i.test(k)) {
            const v = ls.getItem(k);
            if (v && v.length > 30 && !v.startsWith('{') && !v.startsWith('[')) return v;
          }
        }
      } catch (e) {}

      try {
        const nuxtState = uw.__NUXT_STATE__ || uw.__nuxt || uw.__NUXT__;
        if (nuxtState) {
          const str = JSON.stringify(nuxtState);
          const m = str.match(/"(?:session|token|accessToken)"\s*:\s*"([a-f0-9]{40,})"/i);
          if (m) return m[1];
        }
      } catch (e) {}
    } catch (e) {}
    return null;
  }

  let rates = {};

  async function fetchRates(token) {
    const headers = {
      'accept': '*/*',
      'content-type': 'application/json',
      'x-language': 'en',
      'x-operation-name': 'CurrencyConfiguration',
      'x-operation-type': 'query'
    };
    if (token) headers['x-access-token'] = token;

    const res = await fetch('/_api/graphql', {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({
        query: `query CurrencyConfiguration($isAcp: Boolean!) {
          currencyConfiguration(isAcp: $isAcp) {
            baseRates {
              currency
              baseRate
            }
          }
        }`,
        variables: { isAcp: false }
      })
    });

    const text = await res.text();
    if (text.trim().startsWith('<')) return;
    const json = JSON.parse(text);
    const list = json?.data?.currencyConfiguration?.baseRates || [];
    const map = {};
    for (const { currency, baseRate } of list) {
      map[currency.toLowerCase()] = parseFloat(baseRate) || 0;
    }
    rates = map;
  }

  async function gqlPost(operationName, query, variables, token) {
    const headers = {
      'accept': '*/*',
      'content-type': 'application/json',
      'x-language': 'en',
      'x-operation-name': operationName,
      'x-operation-type': 'query'
    };
    if (token) headers['x-access-token'] = token;

    const res = await fetch('/_api/graphql', {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({ query, variables })
    });

    const text = await res.text();
    if (text.trim().startsWith('<')) {
      throw new Error(`Server returned HTML (status ${res.status}). Make sure you are logged in.`);
    }
    let json;
    try { json = JSON.parse(text); } catch (e) {
      throw new Error(`Invalid JSON: ${text.slice(0, 120)}`);
    }
    if (json.errors) {
      throw new Error(`GraphQL error: ${json.errors.map(e => e.message).join(', ')}`);
    }
    return json;
  }

  async function fetchChallenges(offset, token) {
    if (isStakeUS()) {
      return gqlPost('ChallengePublicList', GQL_QUERY_US, {
        sort: 'multiplier',
        direction: 'asc',
        limit: FETCH_LIMIT,
        offset
      }, token);
    }
    return gqlPost('ChallengeList', GQL_QUERY_AC, {
      sort: 'multiplier',
      direction: 'asc',
      type: 'available',
      count: 'available',
      limit: FETCH_LIMIT,
      offset
    }, token);
  }

  async function fetchAllChallenges(token, onProgress) {
    let all = [];
    let offset = 0;
    let total = null;
    const us = isStakeUS();

    for (let page = 0; page < MAX_PAGES; page++) {
      let data;
      try {
        data = await fetchChallenges(offset, token);
      } catch (e) {
        if (all.length > 0 && /number_less_equal|less_equal/i.test(e.message)) break;
        throw e;
      }

      let list, count;
      if (us) {
        list = data?.data?.challengeUnauthenticatedUserList || [];
        count = data?.data?.challengeUnauthenticatedUserCount;
      } else {
        const user = data?.data?.user;
        if (!user) throw new Error('No user data returned. Make sure you are logged in.');
        list = user.challengeList || [];
        count = user.challengeCount;
      }

      if (total === null) total = count || 0;
      all = all.concat(list);
      offset += FETCH_LIMIT;

      if (onProgress) onProgress(all.length, total);
      if (list.length < FETCH_LIMIT || (total > 0 && all.length >= total)) break;
    }

    return all;
  }

  function prizeUsd(c) {
    const amount = parseFloat(c.award) || 0;
    if (!amount) return 0;
    const cur = (c.currency || '').toLowerCase();
    const rate = rates[cur];
    if (rate) return amount * rate;
    return amount;
  }

  function computeNormalizedScores(challenges, weights) {
    if (!challenges.length) return;

    const bets   = challenges.map(c => Math.log1p(parseFloat(c.minBetUsd) || 0));
    const multis = challenges.map(c => Math.log1p(parseFloat(c.targetMultiplier) || 0));
    const prizes = challenges.map(c => Math.log1p(prizeUsd(c)));

    const minB = Math.min(...bets),   maxB = Math.max(...bets);
    const minM = Math.min(...multis), maxM = Math.max(...multis);
    const minP = Math.min(...prizes), maxP = Math.max(...prizes);

    const norm = (v, lo, hi) => hi === lo ? 0.5 : (v - lo) / (hi - lo);

    const wb = weights.bet   / 100;
    const wm = weights.multi / 100;
    const wp = weights.prize / 100;

    challenges.forEach((c, i) => {
      const betScore   = 1 - norm(bets[i],   minB, maxB);  // lower bet   → higher score
      const multiScore = 1 - norm(multis[i], minM, maxM);  // lower multi → higher score
      const prizeScore =     norm(prizes[i], minP, maxP);  // higher prize → higher score

      // Bonus: value-ratio efficiency (prize per unit of cost × difficulty)
      const prize  = prizeUsd(c);
      const bet    = parseFloat(c.minBetUsd) || 0.0001;
      const multi  = parseFloat(c.targetMultiplier) || 1;
      c._efficiency = prize / (bet * multi);
      c._prizeUsd   = prize;

      c._score = (betScore * wb + multiScore * wm + prizeScore * wp) * 100;
    });
  }

  function fmt(num, dec = 2) {
    const n = parseFloat(num);
    if (isNaN(n)) return '—';
    return n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }

  function fmtRatio(r) {
    if (!r || !isFinite(r)) return '—';
    if (r >= 1000)  return Math.round(r).toLocaleString('en-US') + 'x';
    if (r >= 10)    return r.toFixed(1) + 'x';
    return r.toFixed(2) + 'x';
  }

  function fmtCurrency(amount, currency) {
    if (!amount || parseFloat(amount) === 0) return '—';
    return `$${fmt(amount)} ${(currency || '').toUpperCase()}`;
  }

  function timeLeft(expireAt) {
    if (!expireAt) return '—';
    const ms = new Date(expireAt) - Date.now();
    if (ms <= 0) return 'Expired';
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  function timeAgo(dateStr) {
    if (!dateStr) return '—';
    const ms = Date.now() - new Date(dateStr);
    if (ms < 0) return 'just now';
    const m = Math.floor(ms / 60000);
    if (m < 60)  return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24)  return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  }

  const CSS = `
    #${SCRIPT_ID}-wrap {
      position: fixed;
      top: 60px;
      right: 16px;
      width: 1080px;
      max-width: calc(100vw - 32px);
      background: #1a1d27;
      border: 1px solid #2e3348;
      border-radius: 12px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.75);
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px;
      color: #d0d4e8;
      display: flex;
      flex-direction: column;
      max-height: calc(100vh - 80px);
      overflow: hidden;
      user-select: none;
    }
    #${SCRIPT_ID}-header {
      display: flex;
      align-items: center;
      padding: 10px 14px;
      background: #12141e;
      border-radius: 12px 12px 0 0;
      cursor: move;
      border-bottom: 1px solid #2e3348;
      gap: 8px;
      flex-shrink: 0;
    }
    #${SCRIPT_ID}-header .sch-title {
      font-weight: 700;
      font-size: 14px;
      color: #fff;
      flex: 1;
      letter-spacing: 0.3px;
    }
    #${SCRIPT_ID}-header .sch-badge {
      background: #2563eb;
      color: #fff;
      border-radius: 20px;
      padding: 2px 8px;
      font-size: 11px;
      font-weight: 600;
    }
    .sch-btn {
      background: #2e3348;
      border: none;
      color: #aaa;
      border-radius: 6px;
      padding: 4px 9px;
      cursor: pointer;
      font-size: 12px;
      transition: background 0.15s;
      font-family: inherit;
    }
    .sch-btn:hover { background: #3e4560; color: #fff; }
    .sch-close { background: #3a1a1a !important; color: #f87171 !important; }
    .sch-close:hover { background: #7f1d1d !important; color: #fff !important; }
    #${SCRIPT_ID}-filters {
      padding: 10px 14px;
      background: #161929;
      border-bottom: 1px solid #2e3348;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: flex-end;
      flex-shrink: 0;
    }
    .sch-filter-group {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .sch-filter-group label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #6b7280;
      font-weight: 600;
    }
    .sch-filter-group input {
      background: #1f2335;
      border: 1px solid #2e3348;
      border-radius: 6px;
      color: #d0d4e8;
      padding: 5px 8px;
      font-size: 12px;
      width: 90px;
      outline: none;
      transition: border-color 0.15s;
      font-family: inherit;
    }
    .sch-filter-group input[type="text"] { width: 140px; }
    .sch-filter-group input:focus { border-color: #2563eb; }
    .sch-weight-row {
      display: flex;
      gap: 14px;
      align-items: center;
      padding: 7px 14px;
      background: #12141e;
      border-bottom: 1px solid #2e3348;
      flex-wrap: wrap;
      flex-shrink: 0;
    }
    .sch-weight-row > span:first-child {
      font-size: 10px;
      color: #6b7280;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .sch-weight-label {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      color: #9ca3af;
    }
    .sch-weight-label input[type="range"] { width: 70px; accent-color: #2563eb; }
    .sch-weight-val { color: #93c5fd; min-width: 24px; font-size: 11px; }
    #${SCRIPT_ID}-status {
      padding: 5px 14px;
      font-size: 11px;
      color: #6b7280;
      background: #12141e;
      border-bottom: 1px solid #2e3348;
      min-height: 24px;
      display: flex;
      align-items: center;
      flex-shrink: 0;
    }
    #${SCRIPT_ID}-status.error { color: #f87171; background: #1a1020; }
    #${SCRIPT_ID}-table-wrap { overflow-y: scroll; overflow-x: auto; flex: 1; min-height: 0; }
    #${SCRIPT_ID}-table-wrap::-webkit-scrollbar { width: 6px; height: 6px; }
    #${SCRIPT_ID}-table-wrap::-webkit-scrollbar-track { background: #12141e; }
    #${SCRIPT_ID}-table-wrap::-webkit-scrollbar-thumb { background: #3e4560; border-radius: 3px; }
    #${SCRIPT_ID}-table-wrap::-webkit-scrollbar-thumb:hover { background: #2563eb; }
    #${SCRIPT_ID}-table-wrap::-webkit-scrollbar-corner { background: #12141e; }
    #${SCRIPT_ID}-table-wrap table { min-width: 100%; width: max-content; border-collapse: collapse; }
    #${SCRIPT_ID}-table-wrap thead th {
      position: sticky;
      top: 0;
      background: #1a1d27;
      padding: 7px 10px;
      text-align: left;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #6b7280;
      border-bottom: 1px solid #2e3348;
      cursor: pointer;
      white-space: nowrap;
    }
    #${SCRIPT_ID}-table-wrap thead th:hover { color: #d0d4e8; }
    #${SCRIPT_ID}-table-wrap thead th.sort-asc::after { content: ' ▲'; color: #2563eb; }
    #${SCRIPT_ID}-table-wrap thead th.sort-desc::after { content: ' ▼'; color: #2563eb; }
    #${SCRIPT_ID}-table-wrap tbody tr { border-bottom: 1px solid #1e2238; }
    #${SCRIPT_ID}-table-wrap tbody tr:hover { background: #1f2338 !important; }
    #${SCRIPT_ID}-table-wrap td { padding: 6px 10px; vertical-align: middle; white-space: nowrap; }
    .sch-game-cell { display: flex; align-items: center; gap: 8px; }
    .sch-game-thumb {
      width: 30px; height: 30px;
      border-radius: 5px;
      object-fit: cover;
      background: #2e3348;
      flex-shrink: 0;
    }
    .sch-game-name {
      color: #e2e8f0;
      font-weight: 500;
      max-width: 150px;
      overflow: hidden;
      text-overflow: ellipsis;
      display: block;
    }
    .sch-play-link {
      color: #60a5fa;
      font-size: 10px;
      text-decoration: none;
      display: block;
      line-height: 1.2;
    }
    .sch-play-link:hover { text-decoration: underline; }
    .sch-score-bar { display: flex; align-items: center; gap: 6px; }
    .sch-bar-bg { width: 54px; height: 5px; background: #2e3348; border-radius: 3px; overflow: hidden; }
    .sch-bar-fill { height: 100%; background: linear-gradient(90deg, #2563eb, #7c3aed); border-radius: 3px; }
    .sch-score-num { font-size: 11px; color: #93c5fd; min-width: 28px; }
    .sch-prize { color: #34d399; font-weight: 600; }
    .sch-bet { color: #fbbf24; }
    .sch-multi { color: #f472b6; }
    .sch-rank-1 { background: rgba(251,191,36,0.05); }
    .sch-rank-2 { background: rgba(156,163,175,0.04); }
    .sch-rank-3 { background: rgba(180,83,9,0.04); }
    .sch-rank-num { font-size: 12px; font-weight: 700; text-align: center; }
    .sch-rank-1 .sch-rank-num { color: #fbbf24; }
    .sch-rank-2 .sch-rank-num { color: #9ca3af; }
    .sch-rank-3 .sch-rank-num { color: #b45309; }
    .sch-empty { text-align: center; padding: 40px; color: #6b7280; }
    #${SCRIPT_ID}-footer {
      padding: 7px 14px;
      background: #12141e;
      border-top: 1px solid #2e3348;
      border-radius: 0 0 12px 12px;
      display: flex;
      gap: 8px;
      align-items: center;
      font-size: 11px;
      color: #6b7280;
      flex-shrink: 0;
    }
    .sch-refresh-btn { background: #1e3a5f !important; border: 1px solid #2563eb !important; color: #60a5fa !important; }
    .sch-refresh-btn:hover { background: #1d4ed8 !important; color: #fff !important; }
    .sch-spinner {
      display: inline-block;
      width: 11px; height: 11px;
      border: 2px solid #2e3348;
      border-top-color: #2563eb;
      border-radius: 50%;
      animation: sch-spin 0.7s linear infinite;
      vertical-align: middle;
      margin-right: 5px;
      flex-shrink: 0;
    }
    @keyframes sch-spin { to { transform: rotate(360deg); } }
    #${SCRIPT_ID}-toggle-btn {
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 2147483646;
      background: linear-gradient(135deg, #1d4ed8, #7c3aed);
      color: #fff;
      border: none;
      border-radius: 50px;
      padding: 10px 18px;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 4px 20px rgba(37,99,235,0.4);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      transition: transform 0.15s, box-shadow 0.15s;
      display: none;
    }
    #${SCRIPT_ID}-toggle-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 24px rgba(37,99,235,0.5);
    }
  `;

  GM_addStyle(CSS);

  let allChallenges = [];
  let filtered = [];
  let sortCol = 'score';
  let sortDir = 'desc';
  let loading = false;
  let maxScore = 1;

  const state = {
    filters: { game: '', maxBet: '', maxMulti: '', minPrize: '', currency: '' },
    weights: { bet: 40, multi: 35, prize: 25 }
  };

  function applyFilters() {
    const f = state.filters;
    const w = state.weights;

    filtered = allChallenges.filter(c => {
      if (f.game && !c.game?.name?.toLowerCase().includes(f.game.toLowerCase())) return false;
      if (f.maxBet !== '' && parseFloat(c.minBetUsd) > parseFloat(f.maxBet)) return false;
      if (f.maxMulti !== '' && parseFloat(c.targetMultiplier) > parseFloat(f.maxMulti)) return false;
      if (f.minPrize !== '' && prizeUsd(c) < parseFloat(f.minPrize)) return false;
      if (f.currency && !c.currency?.toLowerCase().includes(f.currency.toLowerCase())) return false;
      return true;
    });

    computeNormalizedScores(filtered, w);
    maxScore = 100;
    sortData();
  }

  function sortData() {
    filtered.sort((a, b) => {
      let av, bv;
      switch (sortCol) {
        case 'score': av = a._score; bv = b._score; break;
        case 'game': av = (a.game?.name || '').toLowerCase(); bv = (b.game?.name || '').toLowerCase(); break;
        case 'bet': av = parseFloat(a.minBetUsd) || 0; bv = parseFloat(b.minBetUsd) || 0; break;
        case 'multi': av = parseFloat(a.targetMultiplier) || 0; bv = parseFloat(b.targetMultiplier) || 0; break;
        case 'prize': av = prizeUsd(a); bv = prizeUsd(b); break;
        case 'efficiency': av = a._efficiency || 0; bv = b._efficiency || 0; break;
        case 'expires': av = new Date(a.expireAt || 0).getTime(); bv = new Date(b.expireAt || 0).getTime(); break;
        case 'started': av = new Date(a.startAt || 0).getTime(); bv = new Date(b.startAt || 0).getTime(); break;
        default: av = a._score; bv = b._score;
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      // Tiebreaker: newest startAt first (fresher challenges are easier targets)
      return new Date(b.startAt || 0) - new Date(a.startAt || 0);
    });
    renderTable();
  }

  function renderTable() {
    const tbody = document.getElementById(`${SCRIPT_ID}-tbody`);
    const badge = document.getElementById(`${SCRIPT_ID}-badge`);
    const totalEl = document.getElementById(`${SCRIPT_ID}-total`);
    if (!tbody) return;

    if (badge) badge.textContent = filtered.length;
    if (totalEl) totalEl.textContent = filtered.length;

    const ths = document.querySelectorAll(`#${SCRIPT_ID}-wrap thead th[data-col]`);
    ths.forEach(th => {
      th.classList.remove('sort-asc', 'sort-desc');
      if (th.dataset.col === sortCol) th.classList.add(`sort-${sortDir}`);
    });

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td class="sch-empty" colspan="9">${allChallenges.length === 0 ? 'Click Refresh to load challenges' : 'No challenges match your filters'}</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map((c, i) => {
      const rank = i + 1;
      const rankClass = rank <= 3 ? `sch-rank-${rank}` : '';
      const pct = Math.round((c._score / maxScore) * 100);
      const thumb = c.game?.thumbnailUrl
        ? `<img class="sch-game-thumb" src="${c.game.thumbnailUrl}" alt="" loading="lazy">`
        : `<div class="sch-game-thumb"></div>`;
      const playLink = c.game?.slug
        ? `<a class="sch-play-link" href="${location.origin}/casino/games/${c.game.slug}" target="_blank">Open game</a>`
        : '';

      return `<tr class="${rankClass}">
        <td class="sch-rank-num">${rank}</td>
        <td>
          <div class="sch-game-cell">
            ${thumb}
            <div>
              <span class="sch-game-name" title="${c.game?.name || '—'}">${c.game?.name || '—'}</span>
              ${playLink}
            </div>
          </div>
        </td>
        <td>
          <div class="sch-score-bar">
            <div class="sch-bar-bg"><div class="sch-bar-fill" style="width:${pct}%"></div></div>
            <span class="sch-score-num">${pct}</span>
          </div>
        </td>
        <td style="color:#a78bfa;font-size:12px;font-weight:600" title="Prize ÷ (Bet × Multiplier)">${fmtRatio(c._efficiency)}</td>
        <td class="sch-bet">$${fmt(c.minBetUsd)}</td>
        <td class="sch-multi">${fmt(c.targetMultiplier, 1)}x</td>
        <td class="sch-prize">
          $${fmt(prizeUsd(c))}
          <span style="color:#6b7280;font-size:10px;margin-left:3px">${fmt(c.award, 4)} ${(c.currency||'').toUpperCase()}</span>
        </td>
        <td style="color:#6ee7b7;font-size:11px" title="${c.startAt ? new Date(c.startAt).toLocaleString() : ''}">${timeAgo(c.startAt)}</td>
        <td style="color:#9ca3af;font-size:11px">${timeLeft(c.expireAt)}</td>
      </tr>`;
    }).join('');
  }

  function setStatus(msg, spin = false, isError = false) {
    const el = document.getElementById(`${SCRIPT_ID}-status`);
    if (!el) return;
    el.className = isError ? 'error' : '';
    el.innerHTML = spin ? `<span class="sch-spinner"></span>${msg}` : msg;
  }

  async function loadData() {
    if (loading) return;
    loading = true;

    const token = getAccessToken();
    setStatus(`Fetching rates & challenges${token ? '' : ' (no token — using cookies)'}...`, true);

    try {
      const [_, challenges] = await Promise.all([
        fetchRates(token),
        fetchAllChallenges(token, (loaded, total) => {
          setStatus(`Loading... ${loaded}${total ? ' / ' + total : ''} challenges`, true);
        })
      ]);
      allChallenges = challenges;

      const rateCount = Object.keys(rates).length;
      setStatus(`Loaded ${allChallenges.length} challenges — ${rateCount} currency rates fetched — sorted by score`);
      applyFilters();
    } catch (e) {
      setStatus(e.message || String(e), false, true);
      console.error('[ChallengeHunter]', e);
    }

    loading = false;
  }

  function buildUI() {
    if (document.getElementById(`${SCRIPT_ID}-wrap`)) return;

    const wrap = document.createElement('div');
    wrap.id = `${SCRIPT_ID}-wrap`;
    wrap.innerHTML = `
      <div id="${SCRIPT_ID}-header">
        <span class="sch-title">Challenge Hunter</span>
        <span class="sch-badge" id="${SCRIPT_ID}-badge">0</span>
        <button class="sch-btn" id="${SCRIPT_ID}-min-btn" title="Minimize">—</button>
        <button class="sch-btn sch-close" id="${SCRIPT_ID}-close-btn" title="Close">✕</button>
      </div>

      <div id="${SCRIPT_ID}-body">
        <div id="${SCRIPT_ID}-filters">
          <div class="sch-filter-group">
            <label>Game Name</label>
            <input type="text" id="sch-f-game" placeholder="Search game…">
          </div>
          <div class="sch-filter-group">
            <label>Max Bet ($)</label>
            <input type="number" id="sch-f-maxbet" placeholder="e.g. 0.50" step="0.01" min="0">
          </div>
          <div class="sch-filter-group">
            <label>Max Multiplier</label>
            <input type="number" id="sch-f-maxmulti" placeholder="e.g. 10" step="1" min="0">
          </div>
          <div class="sch-filter-group">
            <label>Min Prize ($)</label>
            <input type="number" id="sch-f-minprize" placeholder="e.g. 5" step="0.01" min="0">
          </div>
          <div class="sch-filter-group">
            <label>Currency</label>
            <input type="text" id="sch-f-currency" placeholder="usdt, btc…">
          </div>
          <button class="sch-btn" id="${SCRIPT_ID}-clear-btn" style="align-self:flex-end">Clear</button>
        </div>

        <div class="sch-weight-row">
          <span>Score Weights:</span>
          <span class="sch-weight-label">
            <span>Bet Size</span>
            <input type="range" id="sch-w-bet" min="0" max="100" value="${state.weights.bet}">
            <span class="sch-weight-val" id="sch-w-bet-val">${state.weights.bet}</span>
          </span>
          <span class="sch-weight-label">
            <span>Multiplier</span>
            <input type="range" id="sch-w-multi" min="0" max="100" value="${state.weights.multi}">
            <span class="sch-weight-val" id="sch-w-multi-val">${state.weights.multi}</span>
          </span>
          <span class="sch-weight-label">
            <span>Prize</span>
            <input type="range" id="sch-w-prize" min="0" max="100" value="${state.weights.prize}">
            <span class="sch-weight-val" id="sch-w-prize-val">${state.weights.prize}</span>
          </span>
        </div>

        <div id="${SCRIPT_ID}-status">Ready — click Refresh to load challenges.</div>

        <div id="${SCRIPT_ID}-table-wrap">
          <table>
            <thead>
              <tr>
                <th style="width:36px">#</th>
                <th data-col="game">Game</th>
                <th data-col="score">Score</th>
                <th data-col="efficiency" title="Prize ÷ (Bet × Multiplier) — higher is better value">Value Ratio</th>
                <th data-col="bet">Min Bet</th>
                <th data-col="multi">Multiplier</th>
                <th data-col="prize">Prize (USD)</th>
                <th data-col="started" title="Newest = freshest opportunity, not yet crowded">Started</th>
                <th data-col="expires">Expires</th>
              </tr>
            </thead>
            <tbody id="${SCRIPT_ID}-tbody">
              <tr><td class="sch-empty" colspan="9">Click Refresh to load challenges</td></tr>
            </tbody>
          </table>
        </div>

        <div id="${SCRIPT_ID}-footer">
          <button class="sch-btn sch-refresh-btn" id="${SCRIPT_ID}-refresh-btn">Refresh Challenges</button>
          <span style="flex:1"></span>
          <span>Showing <strong id="${SCRIPT_ID}-total">0</strong> challenges</span>
        </div>
      </div>
    `;

    document.body.appendChild(wrap);

    const body = document.getElementById(`${SCRIPT_ID}-body`);
    let minimized = false;

    document.getElementById(`${SCRIPT_ID}-min-btn`).addEventListener('click', () => {
      minimized = !minimized;
      body.style.display = minimized ? 'none' : '';
    });

    document.getElementById(`${SCRIPT_ID}-close-btn`).addEventListener('click', () => {
      wrap.remove();
      document.getElementById(`${SCRIPT_ID}-toggle-btn`).style.display = 'block';
    });

    document.getElementById(`${SCRIPT_ID}-refresh-btn`).addEventListener('click', loadData);

    document.getElementById(`${SCRIPT_ID}-clear-btn`).addEventListener('click', () => {
      ['sch-f-game','sch-f-maxbet','sch-f-maxmulti','sch-f-minprize','sch-f-currency'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      state.filters = { game: '', maxBet: '', maxMulti: '', minPrize: '', currency: '' };
      applyFilters();
    });

    const filterMap = [
      ['sch-f-game', 'game'],
      ['sch-f-maxbet', 'maxBet'],
      ['sch-f-maxmulti', 'maxMulti'],
      ['sch-f-minprize', 'minPrize'],
      ['sch-f-currency', 'currency']
    ];
    filterMap.forEach(([id, key]) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', () => { state.filters[key] = el.value; applyFilters(); });
    });

    ['bet', 'multi', 'prize'].forEach(key => {
      const slider = document.getElementById(`sch-w-${key}`);
      const valEl = document.getElementById(`sch-w-${key}-val`);
      if (slider) slider.addEventListener('input', () => {
        state.weights[key] = parseInt(slider.value, 10);
        if (valEl) valEl.textContent = slider.value;
        applyFilters();
      });
    });

    document.querySelectorAll(`#${SCRIPT_ID}-wrap thead th[data-col]`).forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.col;
        if (sortCol === col) {
          sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          sortCol = col;
          sortDir = (col === 'game' || col === 'bet' || col === 'multi' || col === 'expires') ? 'asc' : 'desc';
          // For "started": newest first by default (desc = most recent = freshest = easier)
        }
        sortData();
      });
    });

    makeDraggable(wrap, document.getElementById(`${SCRIPT_ID}-header`));

    // Prevent the Stake page from stealing wheel events — let the overlay scroll itself
    const tableWrap = document.getElementById(`${SCRIPT_ID}-table-wrap`);
    if (tableWrap) {
      tableWrap.addEventListener('wheel', (e) => {
        e.stopPropagation();
        const atTop    = tableWrap.scrollTop === 0 && e.deltaY < 0;
        const atBottom = tableWrap.scrollTop + tableWrap.clientHeight >= tableWrap.scrollHeight - 1 && e.deltaY > 0;
        if (!atTop && !atBottom) e.preventDefault();
        tableWrap.scrollTop += e.deltaY;
      }, { passive: false });
    }
  }

  function makeDraggable(el, handle) {
    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      const rect = el.getBoundingClientRect();
      let startX = e.clientX, startY = e.clientY;
      let startLeft = rect.left, startTop = rect.top;
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      el.style.left = startLeft + 'px';
      el.style.top = startTop + 'px';

      const onMove = (e2) => {
        const nx = Math.max(0, Math.min(window.innerWidth - el.offsetWidth, startLeft + e2.clientX - startX));
        const ny = Math.max(0, Math.min(window.innerHeight - 50, startTop + e2.clientY - startY));
        el.style.left = nx + 'px';
        el.style.top = ny + 'px';
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  }

  function createToggleBtn() {
    const btn = document.createElement('button');
    btn.id = `${SCRIPT_ID}-toggle-btn`;
    btn.textContent = 'Challenge Hunter';
    document.body.appendChild(btn);
    btn.addEventListener('click', () => {
      buildUI();
      btn.style.display = 'none';
      loadData();
    });
    return btn;
  }

  function init() {
    createToggleBtn();
    buildUI();
    setTimeout(loadData, 1200);
  }

  if (document.body) {
    init();
  } else {
    window.addEventListener('DOMContentLoaded', init);
  }
})();
