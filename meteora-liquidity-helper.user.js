// ==UserScript==
// @name         Meteora LP Scanner - Open Source
// @namespace    https://github.com/VladimirusRex/meteora-liquidity-helper
// @version      3.0.0
// @description  Display Meteora DLMM pools sorted by TVL/volume. Anti-scam warnings, wash trade detection, GMGN integration.
// @author       vladimirusrex
// @match        https://gmgn.ai/*
// @match        https://trade.padre.gg/*
// @grant        GM_xmlhttpRequest
// @connect      dlmm-api.meteora.ag
// @connect      public-api.birdeye.so
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  console.log('[Meteora Helper] Script loaded ✓');

  // ─── CONFIG ──────────────────────────────────────────────────────────────────
  const API_DLMM          = 'https://dlmm-api.meteora.ag/pair/all';
  const METEORA_POOL_URL  = (address) => `https://www.meteora.ag/dlmm/${address}`;
  const LPAGENT_POOL_URL  = (address) => `https://app.lpagent.io/pools/${address}`;
  const GMGN_TOKEN_URL    = (mint) => `https://gmgn.ai/sol/token/${mint}?ref=meteora-helper`;
  const DEEPNETS_TOKEN_URL = (mint) => `https://deepnets.ai/token/${mint}`;
  const BUBBLEMAPS_URL    = (mint) => `https://app.bubblemaps.io/sol/token/${mint}`;

  const TVL_LOW_THRESHOLD = 10_000;   // $ – warning shallow LP
  const WASH_TRADE_RATIO  = 50;       // volume24h / TVL > 50x → suspicious
  const FETCH_TIMEOUT_MS  = 10_000;

  // Pour volume 1h/5min real : intégrer Birdeye API
  // (nécessite clé gratuite/limitée : https://public-api.birdeye.so/defi/history_price?address=...
  //  mais rate limit strict – 100 req/min sur plan free)
  const BIRDEYE_API_KEY = ''; // Mets ta clé ici pour activer le volume 1h Birdeye

  const PANEL_ID       = 'meteora-lp-panel';
  const VOLUME_PERIODS = ['24h', '6h', '1h', '5min'];

  // ─── STATE ───────────────────────────────────────────────────────────────────
  let currentMint    = null;
  let selectedPeriod = '24h';
  let cachedPools    = null;
  let isFetching     = false;
  let lastUrl        = location.href;

  // ─── UTILS ───────────────────────────────────────────────────────────────────

  function formatUSD(value) {
    if (value == null || isNaN(value)) return 'N/A';
    if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
    if (value >= 1_000)     return `$${(value / 1_000).toFixed(1)}K`;
    return `$${value.toFixed(2)}`;
  }

  // L'API DLMM publique n'expose que le volume 24h de façon fiable.
  // 6h/1h/5min sont null sauf si l'endpoint les expose un jour.
  function getVolumeForPeriod(pool, period) {
    const map = {
      '24h':  pool.volume?.['24h']  ?? pool.volume_24h ?? null,
      '6h':   pool.volume?.['6h']   ?? null,
      '1h':   pool.volume?.['1h']   ?? null,
      '5min': pool.volume?.['5min'] ?? null,
    };
    return map[period] ?? null;
  }

  function sortPools(pools, period) {
    return [...pools].sort((a, b) => {
      const tvlDiff = (b.tvl ?? 0) - (a.tvl ?? 0);
      if (tvlDiff !== 0) return tvlDiff;
      const volA = getVolumeForPeriod(a, period) ?? 0;
      const volB = getVolumeForPeriod(b, period) ?? 0;
      return volB - volA;
    });
  }

  function calculateTotalTVL(pools) {
    return pools.reduce((sum, p) => sum + (p.tvl ?? 0), 0);
  }

  function calculateTotalVolume24h(pools) {
    return pools.reduce((sum, p) => sum + (p.volume_24h ?? 0), 0);
  }

  function isValidMint(str) {
    return /^[A-HJ-NP-Za-km-z1-9]{32,44}$/.test(str);
  }

  // ─── BIRDEYE VOLUME (optionnel – nécessite clé API) ──────────────────────────

  /**
   * Fetch volume 1h depuis Birdeye si clé configurée, sinon skip.
   * Rate limit : ~100 req/min sur plan free.
   */
  async function fetchBirdeyeVolume(mint) {
    if (!BIRDEYE_API_KEY) return null;
    const url = `https://public-api.birdeye.so/defi/history_price?address=${mint}&type=1H`;
    try {
      const data = await gmFetch(url, FETCH_TIMEOUT_MS, { 'X-API-KEY': BIRDEYE_API_KEY });
      if (!data?.data) return null;
      // Birdeye retourne des candles – somme le volume de la dernière heure
      const items = data.data.items ?? [];
      const lastHour = items.slice(-1)[0];
      return lastHour?.v ?? null;
    } catch (e) {
      console.warn('[Meteora Helper] Birdeye volume fetch failed:', e.message);
      return null;
    }
  }

  // ─── TOKEN MINT EXTRACTION ───────────────────────────────────────────────────

  function extractMintFromURL() {
    const path = location.pathname;
    // gmgn.ai/sol/token/<MINT> ou /sol/address/<MINT>
    let match = path.match(/\/(?:token|address)\/([A-HJ-NP-Za-km-z1-9]{32,44})/);
    if (match) return match[1];
    // trade.padre.gg/token/<MINT> ou /trade/<MINT>
    match = path.match(/\/(?:token|trade)\/([A-HJ-NP-Za-km-z1-9]{32,44})/);
    if (match) return match[1];
    return null;
  }

  /**
   * Scan DOM de façon agressive pour trouver un mint base58.
   * Cible les classes courantes GMGN / Padre + attributs data-*.
   */
  function extractMintFromDOM() {
    // 1) Attributs spécifiques et classes explicites
    const attrSelectors = [
      '[data-mint]',
      '[data-address]',
      '[data-contract]',
      '.token-address',
      '.mint-address',
      '.contract-address',
      '[class*="tokenAddress"]',
      '[class*="mintAddress"]',
      '[class*="contractAddress"]',
      '[class*="token-address"]',
      '[class*="mint-address"]',
      '[class*="address"]',
      '[class*="mint"]',
      '[class*="contract"]',
      'input[value]',
    ];

    for (const sel of attrSelectors) {
      const elements = document.querySelectorAll(sel);
      for (const el of elements) {
        const text = (
          el.getAttribute('data-mint') ||
          el.getAttribute('data-address') ||
          el.getAttribute('data-contract') ||
          el.value ||
          el.textContent ||
          ''
        ).trim();
        if (isValidMint(text)) return text;
      }
    }

    // 2) Scan textContent brut de tous les spans/divs/a (plus lent – dernier recours)
    const candidates = document.querySelectorAll('span, div, p, a, code, small');
    for (const el of candidates) {
      const text = (el.textContent || '').trim();
      if (isValidMint(text)) return text;
    }

    return null;
  }

  function getCurrentMint() {
    return extractMintFromURL() || extractMintFromDOM();
  }

  // ─── FETCH HELPERS ───────────────────────────────────────────────────────────

  /**
   * Wrapper GM_xmlhttpRequest → Promise, avec fallback native fetch.
   * @param {string} url
   * @param {number} timeoutMs
   * @param {Object} extraHeaders – headers supplémentaires (ex: clé Birdeye)
   */
  function gmFetch(url, timeoutMs = FETCH_TIMEOUT_MS, extraHeaders = {}) {
    if (typeof GM_xmlhttpRequest !== 'undefined') {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          timeout: timeoutMs,
          headers: extraHeaders,
          onload: (res) => {
            try {
              resolve(JSON.parse(res.responseText));
            } catch (e) {
              reject(new Error(`JSON parse error from ${url}`));
            }
          },
          onerror:   () => reject(new Error(`Network error fetching ${url}`)),
          ontimeout: () => reject(new Error(`Timeout fetching ${url}`)),
        });
      });
    }

    // Fallback native fetch
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { signal: controller.signal, headers: extraHeaders })
      .then((r) => {
        clearTimeout(timer);
        if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
        return r.json();
      })
      .catch((e) => {
        clearTimeout(timer);
        throw e;
      });
  }

  // ─── POOL FETCHING (DLMM uniquement) ─────────────────────────────────────────

  /**
   * Fetch tous les pairs DLMM et filtre par tokenMint.
   * Tri par TVL desc directement ici.
   */
  async function fetchDLMMPools(tokenMint) {
    console.log('[Meteora Helper] Fetching DLMM pools for mint:', tokenMint);
    const allPairs = await gmFetch(API_DLMM);
    if (!Array.isArray(allPairs)) throw new Error('DLMM API returned unexpected format');

    const filtered = allPairs
      .filter((p) => p.mint_x === tokenMint || p.mint_y === tokenMint)
      .map((p) => ({
        type:        'DLMM',
        address:     p.address,
        tvl:         parseFloat(p.liquidity) || 0,
        volume_24h:  parseFloat(p.trade_volume_24h) || 0,
        // Granularité fine : capturée si l'API l'expose un jour
        volume: {
          '24h':  parseFloat(p.trade_volume_24h) || null,
          '6h':   p.trade_volume_6h ? parseFloat(p.trade_volume_6h) : null,
          '1h':   p.trade_volume_1h ? parseFloat(p.trade_volume_1h) : null,
          '5min': p.trade_volume_5m ? parseFloat(p.trade_volume_5m) : null,
        },
        feeTier:     p.base_fee_percentage != null ? `${p.base_fee_percentage}%` : null,
        binStep:     p.bin_step ?? null,
        activeBinId: p.active_id ?? null,
        mintA:       p.mint_x,
        mintB:       p.mint_y,
        nameA:       p.name?.split('-')[0] ?? '',
        nameB:       p.name?.split('-')[1] ?? '',
      }))
      .sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0));

    console.log(`[Meteora Helper] Found ${filtered.length} DLMM pool(s)`);
    return filtered;
  }

  // ─── RENDER ──────────────────────────────────────────────────────────────────

  function removePanel() {
    document.getElementById(PANEL_ID)?.remove();
  }

  function injectStyles() {
    if (document.getElementById('meteora-lp-styles')) return;
    const style = document.createElement('style');
    style.id = 'meteora-lp-styles';
    style.textContent = `
      #meteora-lp-panel {
        position: fixed;
        top: 12px;
        right: 12px;
        z-index: 999999;
        width: 540px;
        max-height: 90vh;
        overflow-y: auto;
        background: #0f1117;
        border: 1px solid #2a2d3a;
        border-radius: 10px;
        font-family: 'Inter', 'Segoe UI', sans-serif;
        font-size: 12px;
        color: #e2e8f0;
        box-shadow: 0 8px 32px rgba(0,0,0,0.6);
        padding: 0;
      }
      #meteora-lp-panel .mlp-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px;
        background: #161a24;
        border-bottom: 1px solid #2a2d3a;
        border-radius: 10px 10px 0 0;
        cursor: move;
        user-select: none;
      }
      #meteora-lp-panel .mlp-title {
        font-size: 13px;
        font-weight: 700;
        color: #a78bfa;
        letter-spacing: 0.3px;
      }
      #meteora-lp-panel .mlp-controls {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      #meteora-lp-panel select {
        background: #1e2130;
        border: 1px solid #3a3f55;
        border-radius: 5px;
        color: #e2e8f0;
        padding: 2px 6px;
        font-size: 11px;
        cursor: pointer;
      }
      #meteora-lp-panel .mlp-btn {
        background: #1e2130;
        border: 1px solid #3a3f55;
        border-radius: 5px;
        color: #a78bfa;
        font-size: 11px;
        padding: 2px 8px;
        cursor: pointer;
        font-weight: 600;
        transition: background 0.15s;
      }
      #meteora-lp-panel .mlp-btn:hover { background: #2a2d3a; }
      #meteora-lp-panel .mlp-btn.gmgn {
        background: rgba(96,165,250,0.12);
        border-color: rgba(96,165,250,0.35);
        color: #60a5fa;
      }
      #meteora-lp-panel .mlp-btn.gmgn:hover { background: rgba(96,165,250,0.22); }
      #meteora-lp-panel .mlp-close {
        background: none;
        border: none;
        color: #64748b;
        font-size: 16px;
        cursor: pointer;
        padding: 0 4px;
        line-height: 1;
      }
      #meteora-lp-panel .mlp-close:hover { color: #e2e8f0; }
      #meteora-lp-panel .mlp-body { padding: 10px 14px; }
      #meteora-lp-panel .mlp-spinner {
        text-align: center;
        padding: 20px;
        color: #64748b;
      }
      #meteora-lp-panel .mlp-warning {
        padding: 8px 12px;
        border-radius: 6px;
        margin-bottom: 8px;
        font-weight: 600;
        font-size: 11.5px;
        line-height: 1.5;
      }
      #meteora-lp-panel .mlp-warning.red {
        background: rgba(239,68,68,0.15);
        border: 1px solid rgba(239,68,68,0.4);
        color: #fca5a5;
      }
      #meteora-lp-panel .mlp-warning.yellow {
        background: rgba(234,179,8,0.12);
        border: 1px solid rgba(234,179,8,0.35);
        color: #fde047;
      }
      #meteora-lp-panel .mlp-warning.orange {
        background: rgba(249,115,22,0.15);
        border: 1px solid rgba(249,115,22,0.45);
        color: #fdba74;
        font-size: 12px;
      }
      #meteora-lp-panel .mlp-stats {
        display: flex;
        gap: 10px;
        margin-bottom: 10px;
        flex-wrap: wrap;
      }
      #meteora-lp-panel .mlp-stat {
        background: #161a24;
        border: 1px solid #2a2d3a;
        border-radius: 6px;
        padding: 5px 10px;
        flex: 1;
        min-width: 100px;
      }
      #meteora-lp-panel .mlp-stat-label {
        color: #475569;
        font-size: 10px;
        text-transform: uppercase;
        margin-bottom: 2px;
      }
      #meteora-lp-panel .mlp-stat-value {
        color: #e2e8f0;
        font-weight: 700;
        font-size: 13px;
      }
      #meteora-lp-panel .mlp-stat-value.purple { color: #a78bfa; }
      #meteora-lp-panel .mlp-stat-value.orange { color: #fb923c; }
      #meteora-lp-panel .mlp-stat-value.green  { color: #34d399; }
      #meteora-lp-panel .mlp-manual-input {
        display: flex;
        gap: 6px;
        margin-bottom: 10px;
      }
      #meteora-lp-panel .mlp-manual-input input {
        flex: 1;
        background: #1e2130;
        border: 1px solid #3a3f55;
        border-radius: 5px;
        color: #e2e8f0;
        padding: 4px 8px;
        font-size: 11px;
        font-family: monospace;
      }
      #meteora-lp-panel table {
        width: 100%;
        border-collapse: collapse;
        margin-top: 4px;
      }
      #meteora-lp-panel th {
        text-align: left;
        padding: 5px 6px;
        font-size: 10px;
        text-transform: uppercase;
        color: #64748b;
        border-bottom: 1px solid #1e2130;
      }
      #meteora-lp-panel td {
        padding: 6px 6px;
        border-bottom: 1px solid #1a1d2a;
        vertical-align: middle;
      }
      #meteora-lp-panel tr:last-child td { border-bottom: none; }
      #meteora-lp-panel tr:hover td { background: rgba(167,139,250,0.04); }
      #meteora-lp-panel .mlp-badge {
        display: inline-block;
        padding: 1px 6px;
        border-radius: 4px;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.3px;
        background: rgba(139,92,246,0.2);
        color: #c4b5fd;
        border: 1px solid rgba(139,92,246,0.4);
      }
      #meteora-lp-panel .mlp-link {
        color: #60a5fa;
        text-decoration: none;
        font-size: 11px;
      }
      #meteora-lp-panel .mlp-link:hover { text-decoration: underline; color: #93c5fd; }
      #meteora-lp-panel .mlp-na { color: #3a3f55; font-style: italic; font-size: 10px; }
      #meteora-lp-panel .mlp-footer {
        padding: 8px 14px;
        border-top: 1px solid #1e2130;
        color: #475569;
        font-size: 10px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
      }
      #meteora-lp-panel .mlp-wash { color: #fb923c; font-weight: 600; font-size: 10px; }
    `;
    document.head.appendChild(style);
  }

  function renderSpinner() {
    removePanel();
    injectStyles();
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="mlp-header">
        <span class="mlp-title">Meteora LP Scanner</span>
        <div class="mlp-controls">
          <button class="mlp-close" id="mlp-close-btn">✕</button>
        </div>
      </div>
      <div class="mlp-body">
        <div class="mlp-spinner">
          <div style="margin-bottom:8px;">⟳ Fetching DLMM pools…</div>
          <div style="color:#3a3f55;font-size:10px;">Querying Meteora API</div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);
    document.getElementById('mlp-close-btn').onclick = () => { removePanel(); syncToggleOff(); };
    makeDraggable(panel);
  }

  /**
   * Panel "No mint detected" avec input manuel pour coller un CA.
   */
  function renderNoMint() {
    removePanel();
    injectStyles();
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="mlp-header">
        <span class="mlp-title">Meteora LP Scanner</span>
        <div class="mlp-controls">
          <button class="mlp-close" id="mlp-close-btn">✕</button>
        </div>
      </div>
      <div class="mlp-body">
        <div class="mlp-warning yellow" style="margin-bottom:12px;">
          ⚠ No mint detected on this page — colle le CA manuellement :
        </div>
        <div class="mlp-manual-input">
          <input id="mlp-manual-ca" type="text" placeholder="Colle le contract address (base58)..." />
          <button class="mlp-btn" id="mlp-manual-go">Fetch</button>
        </div>
      </div>
    `;
    document.body.appendChild(panel);
    document.getElementById('mlp-close-btn').onclick = () => { removePanel(); syncToggleOff(); };
    document.getElementById('mlp-manual-go').onclick = () => {
      const val = document.getElementById('mlp-manual-ca').value.trim();
      if (isValidMint(val)) {
        currentMint = val;
        cachedPools = null;
        runWithMint(val);
      } else {
        document.getElementById('mlp-manual-ca').style.borderColor = '#ef4444';
      }
    };
    makeDraggable(panel);
  }

  /**
   * Panel principal avec table pools + stats + warnings.
   */
  function renderPanel(pools, tokenMint) {
    removePanel();
    injectStyles();

    const sorted       = sortPools(pools, selectedPeriod);
    const totalTVL     = calculateTotalTVL(pools);
    const totalVol24h  = calculateTotalVolume24h(pools);
    const ratio        = totalTVL > 0 ? totalVol24h / totalTVL : 0;
    const volLabel     = `Vol ${selectedPeriod}`;
    const isNAperiod   = selectedPeriod !== '24h';

    // ── Warning banners ──
    let warningsHTML = '';

    if (pools.length === 0) {
      warningsHTML += `
        <div class="mlp-warning red">
          ⚠ No Meteora LP found — probable rug ou fake volume pump
        </div>`;
    } else {
      if (totalTVL < TVL_LOW_THRESHOLD) {
        warningsHTML += `
          <div class="mlp-warning yellow">
            ⚠ Shallow LP — TVL total ${formatUSD(totalTVL)} — high dump to zero risk
          </div>`;
      }
      if (ratio > WASH_TRADE_RATIO) {
        warningsHTML += `
          <div class="mlp-warning orange">
            ⚡ <strong>Probable volume botté / wash trading</strong> — ratio Vol24h/TVL = ${ratio.toFixed(1)}x<br>
            <span style="font-weight:400;font-size:11px;">Surveille les top wallets sur GMGN pour snipers/dumpers</span>
          </div>`;
      }
    }

    // ── Stats bar ──
    const ratioColor = ratio > WASH_TRADE_RATIO ? 'orange' : ratio > 10 ? 'purple' : 'green';
    const statsHTML = pools.length > 0 ? `
      <div class="mlp-stats">
        <div class="mlp-stat">
          <div class="mlp-stat-label">Total TVL</div>
          <div class="mlp-stat-value purple">${formatUSD(totalTVL)}</div>
        </div>
        <div class="mlp-stat">
          <div class="mlp-stat-label">Total Vol 24h</div>
          <div class="mlp-stat-value">${formatUSD(totalVol24h)}</div>
        </div>
        <div class="mlp-stat">
          <div class="mlp-stat-label">Vol/TVL ratio</div>
          <div class="mlp-stat-value ${ratioColor}">${totalTVL > 0 ? ratio.toFixed(1) + 'x' : 'N/A'}</div>
        </div>
        <div class="mlp-stat">
          <div class="mlp-stat-label">Pools</div>
          <div class="mlp-stat-value">${pools.length}</div>
        </div>
      </div>` : '';

    // ── Period select ──
    const selectOptions = VOLUME_PERIODS.map(
      (p) => `<option value="${p}" ${p === selectedPeriod ? 'selected' : ''}>${p}</option>`
    ).join('');

    // ── Table rows ──
    const rowsHTML = sorted.map((pool) => {
      const vol = getVolumeForPeriod(pool, selectedPeriod);

      // Pour les périodes non-24h : toujours N/A (API DLMM 24h only)
      const volDisplay = isNAperiod
        ? `<span class="mlp-na">N/A (API DLMM 24h only)</span>`
        : (vol != null ? formatUSD(vol) : `<span class="mlp-na">N/A</span>`);

      const isWash    = pool.tvl > 0 && (pool.volume_24h ?? 0) / pool.tvl > WASH_TRADE_RATIO;
      const washBadge = isWash ? `<span class="mlp-wash"> ⚡</span>` : '';

      const fee = pool.feeTier ?? (pool.binStep != null ? `${(pool.binStep / 100).toFixed(2).replace(/\.?0+$/, '')}%` : null);
      const feeTierDisplay = (pool.binStep != null || fee != null)
        ? `${pool.binStep ?? '?'} / ${fee ?? '?'}`
        : '<span class="mlp-na">N/A</span>';

      return `
        <tr>
          <td>${feeTierDisplay}</td>
          <td>${formatUSD(pool.tvl)}</td>
          <td>${volDisplay}${washBadge}</td>
          <td>
            <a class="mlp-link" href="${METEORA_POOL_URL(pool.address)}" target="_blank" title="${pool.address}">Meteora</a>
            · <a class="mlp-link" href="${LPAGENT_POOL_URL(pool.address)}" target="_blank">LPAgent</a>
          </td>
        </tr>`;
    }).join('');

    const noPoolsRow = pools.length === 0
      ? `<tr><td colspan="6" style="text-align:center;color:#475569;padding:16px;">No DLMM pools found</td></tr>`
      : '';

    // ── GMGN link & button ──
    const gmgnUrl        = tokenMint ? GMGN_TOKEN_URL(tokenMint) : null;
    const gmgnLinkHTML   = gmgnUrl
      ? `<a class="mlp-link" href="${gmgnUrl}" target="_blank">GMGN ↗</a>`
      : '';
    const gmgnBtnHTML    = gmgnUrl && pools.length > 0
      ? `<button class="mlp-btn gmgn" id="mlp-gmgn-btn">Check GMGN</button>`
      : '';

    const shortMint = tokenMint
      ? `${tokenMint.slice(0, 6)}…${tokenMint.slice(-4)}`
      : '—';

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="mlp-header">
        <span class="mlp-title">Meteora LP — ${shortMint}</span>
        <div class="mlp-controls">
          <select id="mlp-period-select">${selectOptions}</select>
          <button class="mlp-btn" id="mlp-refresh-btn" title="Re-fetch DLMM pools">⟳</button>
          ${gmgnBtnHTML}
          <button class="mlp-close" id="mlp-close-btn">✕</button>
        </div>
      </div>
      <div class="mlp-body">
        ${warningsHTML}
        ${statsHTML}
        ${pools.length > 0 ? `
        <table>
          <thead>
            <tr>
              <th>Pool Type</th>
              <th>TVL</th>
              <th>${volLabel}</th>
              <th>Links</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHTML}
          </tbody>
        </table>` : noPoolsRow}
      </div>
      <div class="mlp-footer">
        <span style="color:#475569;font-size:10px;">
          ${gmgnLinkHTML}
          ${gmgnUrl ? ' · ' : ''}
          ${tokenMint ? `<a class="mlp-link" href="${DEEPNETS_TOKEN_URL(tokenMint)}" target="_blank">Deepnets</a> · ` : ''}
          ${tokenMint ? `<a class="mlp-link" href="${BUBBLEMAPS_URL(tokenMint)}" target="_blank">Bubblemaps</a> · ` : ''}
          Updated <span id="mlp-last-updated"></span>
        </span>
        <span style="color:#3a3f55;font-size:9px;" title="${tokenMint ?? ''}">${tokenMint ?? 'no mint'}</span>
      </div>
    `;

    document.body.appendChild(panel);

    // Timestamp
    const now = new Date();
    const ts  = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
    const tsEl = document.getElementById('mlp-last-updated');
    if (tsEl) tsEl.textContent = ts;

    // Period select
    document.getElementById('mlp-period-select').onchange = (e) => {
      selectedPeriod = e.target.value;
      renderPanel(cachedPools || [], tokenMint);
    };

    // Refresh button – force re-fetch
    document.getElementById('mlp-refresh-btn').onclick = () => {
      cachedPools = null;
      runWithMint(tokenMint);
    };

    // Check GMGN button
    document.getElementById('mlp-gmgn-btn')?.addEventListener('click', () => {
      window.open(gmgnUrl, '_blank');
    });

    document.getElementById('mlp-close-btn').onclick = () => { removePanel(); syncToggleOff(); };
    makeDraggable(panel);
  }

  function renderError(message) {
    removePanel();
    injectStyles();
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="mlp-header">
        <span class="mlp-title">Meteora LP Scanner</span>
        <div class="mlp-controls">
          <button class="mlp-btn" id="mlp-refresh-btn" title="Retry">⟳</button>
          <button class="mlp-close" id="mlp-close-btn">✕</button>
        </div>
      </div>
      <div class="mlp-body">
        <div class="mlp-warning red">✕ Error: ${message}</div>
      </div>
    `;
    document.body.appendChild(panel);
    document.getElementById('mlp-refresh-btn').onclick = () => {
      cachedPools = null;
      currentMint = null;
      run();
    };
    document.getElementById('mlp-close-btn').onclick = () => { removePanel(); syncToggleOff(); };
    makeDraggable(panel);
  }

  // ─── DRAG TO MOVE ────────────────────────────────────────────────────────────

  function makeDraggable(panel) {
    const header = panel.querySelector('.mlp-header');
    if (!header) return;
    let dragging = false, ox = 0, oy = 0;

    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('button, select, input')) return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      ox = e.clientX - rect.left;
      oy = e.clientY - rect.top;
      panel.style.right = 'auto';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left = `${e.clientX - ox}px`;
      panel.style.top  = `${e.clientY - oy}px`;
    });

    document.addEventListener('mouseup', () => { dragging = false; });
  }

  // ─── MAIN FLOW ───────────────────────────────────────────────────────────────

  /**
   * Fetch + render pour un mint donné (utilisé aussi depuis l'input manuel).
   */
  async function runWithMint(mint) {
    if (isFetching) return;
    console.log('[Meteora Helper] Mint extrait :', mint);

    isFetching = true;
    renderSpinner();

    try {
      const pools = await fetchDLMMPools(mint);
      cachedPools = pools;
      renderPanel(pools, mint);
    } catch (err) {
      console.error('[Meteora Helper] Fetch error:', err);
      renderError(err.message || 'Unknown error');
    } finally {
      isFetching = false;
    }
  }

  async function run() {
    if (isFetching) return;

    const mint = getCurrentMint();

    if (!mint) {
      console.log('[Meteora Helper] No mint detected on this page');
      renderNoMint();
      return;
    }

    console.log('[Meteora Helper] Mint extrait :', mint);

    // Même mint déjà chargé → re-render depuis cache sans re-fetch
    if (mint === currentMint && cachedPools !== null) {
      renderPanel(cachedPools, currentMint);
      return;
    }

    currentMint = mint;
    cachedPools = null;
    await runWithMint(mint);
  }

  // ─── SPA NAVIGATION OBSERVER ─────────────────────────────────────────────────

  function watchNavigation() {
    const originalPush    = history.pushState.bind(history);
    const originalReplace = history.replaceState.bind(history);

    function onNavigate() {
      const newUrl = location.href;
      if (newUrl !== lastUrl) {
        lastUrl     = newUrl;
        cachedPools = null;
        currentMint = null;
        setTimeout(run, 500);
      }
    }

    history.pushState    = (...args) => { originalPush(...args);    onNavigate(); };
    history.replaceState = (...args) => { originalReplace(...args); onNavigate(); };
    window.addEventListener('popstate',   onNavigate);
    window.addEventListener('hashchange', onNavigate);
  }

  function watchDOM() {
    let debounceTimer = null;
    const observer = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const mint = getCurrentMint();
        if (mint && mint !== currentMint) {
          cachedPools = null;
          run();
        }
      }, 800);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ─── TOGGLE BUTTON ───────────────────────────────────────────────────────────

  const TOGGLE_ID = 'meteora-lp-toggle';
  let panelVisible = false;

  function injectToggle() {
    if (document.getElementById(TOGGLE_ID)) return;

    const btn = document.createElement('button');
    btn.id = TOGGLE_ID;
    btn.textContent = 'MLP';
    btn.title = 'Meteora LP Scanner';
    btn.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 999998;
      background: #1e1b4b;
      color: #a78bfa;
      border: 1px solid #4c1d95;
      border-radius: 6px;
      padding: 4px 10px;
      font-size: 11px;
      font-weight: 700;
      font-family: 'Inter', 'Segoe UI', sans-serif;
      cursor: pointer;
      letter-spacing: 0.5px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.4);
      transition: background 0.15s, color 0.15s;
    `;

    btn.addEventListener('mouseenter', () => {
      btn.style.background = '#2e1065';
      btn.style.color = '#c4b5fd';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = panelVisible ? '#2e1065' : '#1e1b4b';
      btn.style.color = panelVisible ? '#c4b5fd' : '#a78bfa';
    });

    btn.addEventListener('click', () => {
      if (panelVisible) {
        removePanel();
        panelVisible = false;
        btn.style.background = '#1e1b4b';
        btn.style.color = '#a78bfa';
      } else {
        panelVisible = true;
        btn.style.background = '#2e1065';
        btn.style.color = '#c4b5fd';
        run();
      }
    });

    document.body.appendChild(btn);
  }

  // Reset le toggle quand le × du panel est cliqué
  function syncToggleOff() {
    panelVisible = false;
    const btn = document.getElementById(TOGGLE_ID);
    if (btn) {
      btn.style.background = '#1e1b4b';
      btn.style.color = '#a78bfa';
    }
  }

  // ─── INIT ────────────────────────────────────────────────────────────────────

  watchNavigation();
  watchDOM();

  // Injecte le toggle dès que le body est dispo
  setTimeout(() => {
    injectToggle();
  }, 800);

  // Ne plus lancer run() automatiquement – seulement sur clic du toggle

})();
