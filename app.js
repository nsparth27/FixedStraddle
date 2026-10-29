// Future & Option — Straddle Signal Scanner
const byId = id => document.getElementById(id);
const safeText = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const fmt = (value, dec = 2) => value == null || value === '' || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec });

let state = null;
let liveRows = [];
let universe = [];
let universeLoaded = false;
let universeState = { status: 'not-started', total: 0, done: 0, errors: [] };
let stockEmaRows = [];
let stockEmaScanState = { status: 'not-started', done: 0, total: 0, alerts: 0, errors: 0, updatedAt: null };

const chainStates = {
  stocks: { data: null, ce: null, pe: null },
  indices: { data: null, ce: null, pe: null }
};

const chainIds = mode => mode === 'indices'
  ? { underlying: 'indexUnderlyingSelect', expiry: 'indicesExpirySelect', rows: 'indicesChainRows', add: 'addIndexWatchlist', status: 'indicesChainSelectionStatus', summary: 'indicesChainSummary', price: 'indicesChainUnderlyingPrice' }
  : { underlying: 'underlyingSelect', expiry: 'expirySelect', rows: 'chainRows', add: 'addWatchlist', status: 'chainSelectionStatus', summary: 'chainSummary', price: 'chainUnderlyingPrice' };

function toast(message) {
  const el = byId('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.remove('show'), 2800);
}

function timeframeLabel(minutes) {
  const num = Number(minutes);
  if (!num) return '—';
  if (num < 60) return `${num}m`;
  if (num < 1440) return `${Math.round(num / 60)}h`;
  return `${Math.round(num / 1440)}D`;
}

function formatDateDisplay(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso || '—';
  const parts = iso.slice(0, 10).split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${parts[2]} ${months[parseInt(parts[1], 10) - 1] || parts[1]}`;
}

const isIndexPair = row => String(row.kind || '').toLowerCase() === 'index';
const isStranglePair = row => {
  const ce = Number(row.ceStrike ?? row.ce?.strike ?? 0);
  const pe = Number(row.peStrike ?? row.pe?.strike ?? 0);
  return ce > 0 && pe > 0 && ce !== pe;
};

const pairTimeframe = row => {
  if (row.timeframe && Number(row.timeframe) > 0) return Number(row.timeframe);
  const isIdx = isIndexPair(row);
  const isStrg = isStranglePair(row);
  if (isIdx) return isStrg ? (Number(state?.settings?.indexStrangleTimeframe) || 1) : (Number(state?.settings?.indexStraddleTimeframe) || 5);
  return isStrg ? (Number(state?.settings?.stockStrangleTimeframe) || 5) : (Number(state?.settings?.stockStraddleTimeframe) || 15);
};

// Indicator Help Tooltip
function indicatorHelp(r, type, required, ready) {
  const tf = pairTimeframe(r);
  const tfLbl = timeframeLabel(tf);
  const isStrg = isStranglePair(r);
  const strategyName = isStrg ? 'Strangle' : 'Straddle';
  const prefix = ready ? `${tfLbl} ${strategyName} candle ready.` : `Collecting ${tfLbl} closed candles (${r.indicatorBars || 0}/${required} bars).`;
  if (type === 'macd') return `${prefix} MACD = 12 EMA − 26 EMA on ${tfLbl} timeframe.`;
  if (type === 'ema') return `${prefix} 200 EMA of ${strategyName} on ${tfLbl} timeframe.`;
  return prefix;
}

function macdCell(r) {
  if (r.macdReady && r.macd != null) {
    const isUp = r.macd >= 0;
    return `<td class="num ${isUp ? 'macd-positive up' : 'macd-negative warn'}" title="${safeText(indicatorHelp(r, 'macd', r.macdBarsRequired || 26, true))}">${fmt(r.macd)}</td>`;
  }
  return `<td class="num neutral" title="${safeText(indicatorHelp(r, 'macd', r.macdBarsRequired || 26, false))}"><span style="font-size:10px;opacity:0.7">warming (${r.indicatorBars || 0}/${r.macdBarsRequired || 26})</span></td>`;
}

function emaCell(r) {
  if (r.emaReady && r.ema != null) {
    const isAbove = (r.straddle || 0) >= r.ema;
    return `<td class="num ${isAbove ? 'up' : 'neutral'}" title="${safeText(indicatorHelp(r, 'ema', r.emaBarsRequired || 200, true))}">${fmt(r.ema)}</td>`;
  }
  return `<td class="num neutral" title="${safeText(indicatorHelp(r, 'ema', r.emaBarsRequired || 200, false))}"><span style="font-size:10px;opacity:0.7">warming (${r.indicatorBars || 0}/${r.emaBarsRequired || 200})</span></td>`;
}

function straddleCell(r) {
  const diff = r.change != null ? r.change : null;
  const pct = r.changePct != null ? `${r.changePct >= 0 ? '+' : ''}${fmt(r.changePct, 1)}%` : '';
  const clr = diff == null ? '' : diff >= 0 ? 'up' : 'neutral';
  return `<td class="num ${clr}">${fmt(r.straddle)} ${pct ? `<span class="subline" style="display:inline;margin-left:4px;font-size:10px">${pct}</span>` : ''}</td>`;
}

// -------------------------------------------------------------
// Watchlist & Alerts Rendering
// -------------------------------------------------------------
function renderWatchlist(contracts = []) {
  liveRows = contracts;

  // Filter for Stocks Watchlist
  const stockRows = contracts.filter(r => !isIndexPair(r));
  const stockSearch = (byId('search')?.value || '').trim().toLowerCase();
  const stockFilter = byId('signalFilter')?.value || 'all';

  const filteredStocks = stockRows.filter(r => {
    if (stockSearch && !r.symbol.toLowerCase().includes(stockSearch) && !(r.underlying || '').toLowerCase().includes(stockSearch)) return false;
    if (stockFilter === 'five' && r.alert !== 5) return false;
    if (stockFilter === 'alerts' && (!r.alert || r.alert < 3)) return false;
    return true;
  });

  const stockTbody = byId('scannerRows');
  if (stockTbody) {
    stockTbody.innerHTML = filteredStocks.map(r => {
      const isStrg = isStranglePair(r);
      const pairType = isStrg ? 'Strangle' : 'Straddle';
      const tf = pairTimeframe(r);
      const tfLbl = timeframeLabel(tf);
      return `<tr>
        <td>
          <div class="symbol">${safeText(r.underlying || r.symbol)}<span class="instrument-type">${safeText(r.kind || 'Stock')}</span><span class="pair-type-tag ${isStrg ? 'strangle' : 'straddle'}">${pairType} · ${tfLbl}</span></div>
          <span class="watch-expiry" title="${safeText(r.expiry)}">${safeText(formatDateDisplay(r.expiry))}</span>
        </td>
        <td class="num">${fmt(r.ceStrike)}</td><td class="num">${fmt(r.ceLtp)}</td>
        <td class="num">${fmt(r.peStrike)}</td><td class="num">${fmt(r.peLtp)}</td>
        ${straddleCell(r)}${macdCell(r)}${emaCell(r)}
        <td>${r.alert === 5 ? '<span class="star">★★★★★</span>' : r.alert === 3 ? '<span class="signal-three star">★★★</span>' : '<span class="neutral">—</span>'}</td>
        <td><button class="remove-watch" data-remove="${safeText(r.symbol)}" title="Remove pair">✕</button></td>
      </tr>`;
    }).join('') || '<tr><td colspan="10" class="empty">No stock straddles/strangles added yet. Select an underlying above.</td></tr>';
  }

  const stockSummary = byId('rowSummary');
  if (stockSummary) stockSummary.textContent = `Showing ${filteredStocks.length} of ${stockRows.length} stock pair${stockRows.length === 1 ? '' : 's'}`;

  // Filter for Indices Watchlist
  const indexRows = contracts.filter(r => isIndexPair(r));
  const indexSearch = (byId('indexSearch')?.value || '').trim().toLowerCase();
  const indexFilter = byId('indexSignalFilter')?.value || 'all';

  const filteredIndices = indexRows.filter(r => {
    if (indexSearch && !r.symbol.toLowerCase().includes(indexSearch) && !(r.underlying || '').toLowerCase().includes(indexSearch)) return false;
    if (indexFilter === 'five' && r.alert !== 5) return false;
    if (indexFilter === 'alerts' && (!r.alert || r.alert < 3)) return false;
    return true;
  });

  const indexTbody = byId('indexScannerRows');
  if (indexTbody) {
    indexTbody.innerHTML = filteredIndices.map(r => {
      const isStrg = isStranglePair(r);
      const pairType = isStrg ? 'Strangle' : 'Straddle';
      const tf = pairTimeframe(r);
      const tfLbl = timeframeLabel(tf);
      return `<tr>
        <td>
          <div class="symbol">${safeText(r.underlying || r.symbol)}<span class="instrument-type">${safeText(r.kind || 'Index')}</span><span class="pair-type-tag ${isStrg ? 'strangle' : 'straddle'}">${pairType} · ${tfLbl}</span></div>
          <span class="watch-expiry" title="${safeText(r.expiry)}">${safeText(formatDateDisplay(r.expiry))}</span>
        </td>
        <td class="num">${fmt(r.ceStrike)}</td><td class="num">${fmt(r.ceLtp)}</td>
        <td class="num">${fmt(r.peStrike)}</td><td class="num">${fmt(r.peLtp)}</td>
        ${straddleCell(r)}${macdCell(r)}${emaCell(r)}
        <td>${r.alert === 5 ? '<span class="star">★★★★★</span>' : r.alert === 3 ? '<span class="signal-three star">★★★</span>' : '<span class="neutral">—</span>'}</td>
        <td><button class="remove-watch" data-remove="${safeText(r.symbol)}" title="Remove pair">✕</button></td>
      </tr>`;
    }).join('') || '<tr><td colspan="10" class="empty">No index straddles/strangles added yet. Select an index above.</td></tr>';
  }

  const indexSummary = byId('indexRowSummary');
  if (indexSummary) indexSummary.textContent = `Showing ${filteredIndices.length} of ${indexRows.length} index pair${indexRows.length === 1 ? '' : 's'}`;

  renderAlerts();
  renderStrategyViews();
}

function renderAlerts() {
  const filter = byId('alertLevelFilter')?.value || 'all';
  const rows = liveRows.filter(r => r.alert > 0 && (filter === 'all' || (filter === 'five' && r.alert === 5) || (filter === 'three' && r.alert === 3)));
  const alertTbody = byId('alertRows');
  if (alertTbody) {
    alertTbody.innerHTML = rows.map(r => {
      const isStrg = isStranglePair(r);
      const pairType = isStrg ? 'Strangle' : 'Straddle';
      const tf = pairTimeframe(r);
      const tfLbl = timeframeLabel(tf);
      return `<tr>
        <td>
          <div class="symbol">${safeText(r.underlying || r.symbol)}<span class="instrument-type">${safeText(r.kind || 'F&O')}</span><span class="pair-type-tag ${isStrg ? 'strangle' : 'straddle'}">${pairType} · ${tfLbl}</span></div>
          <span class="watch-expiry" title="${safeText(r.expiry)}">${safeText(formatDateDisplay(r.expiry))}</span>
        </td>
        <td class="num">${fmt(r.ceStrike)}</td><td class="num">${fmt(r.ceLtp)}</td>
        <td class="num">${fmt(r.peStrike)}</td><td class="num">${fmt(r.peLtp)}</td>
        ${straddleCell(r)}${macdCell(r)}${emaCell(r)}
        <td>${r.alert === 5 ? '<span class="star">★★★★★</span>' : '<span class="signal-three star">★★★</span>'}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="9" class="empty">No active alerts right now. Your monitored pairs remain in the Watchlist.</td></tr>';
  }
  const summary = byId('alertSummary');
  if (summary) summary.textContent = `Showing ${rows.length} active ${rows.length === 1 ? 'alert' : 'alerts'} from ${liveRows.length} watched pairs`;
}

// -------------------------------------------------------------
// Strategy Page (CE/PE MACD Momentum)
// -------------------------------------------------------------
let activeStrategyTab = 'ceMacdPos';

function renderStrategyViews() {
  let cePos = 0, ceNeg = 0, pePos = 0, peNeg = 0;
  for (const r of liveRows) {
    if (r.ceMacd != null) {
      if (r.ceMacd >= 0) cePos++;
      else ceNeg++;
    }
    if (r.peMacd != null) {
      if (r.peMacd >= 0) pePos++;
      else peNeg++;
    }
  }

  if (byId('cardCeMacdPosCount')) byId('cardCeMacdPosCount').textContent = cePos;
  if (byId('navCeMacdPosCount')) byId('navCeMacdPosCount').textContent = cePos;
  if (byId('cardCeMacdNegCount')) byId('cardCeMacdNegCount').textContent = ceNeg;
  if (byId('navCeMacdNegCount')) byId('navCeMacdNegCount').textContent = ceNeg;
  if (byId('cardPeMacdPosCount')) byId('cardPeMacdPosCount').textContent = pePos;
  if (byId('navPeMacdPosCount')) byId('navPeMacdPosCount').textContent = pePos;
  if (byId('cardPeMacdNegCount')) byId('cardPeMacdNegCount').textContent = peNeg;
  if (byId('navPeMacdNegCount')) byId('navPeMacdNegCount').textContent = peNeg;

  const tbody = byId('strategyRows');
  if (!tbody) return;

  const isCe = activeStrategyTab.startsWith('ce');
  const isPos = activeStrategyTab.endsWith('Pos');

  const filtered = liveRows.filter(r => {
    const val = isCe ? r.ceMacd : r.peMacd;
    if (val == null) return false;
    return isPos ? val >= 0 : val < 0;
  });

  tbody.innerHTML = filtered.map(r => {
    const strike = isCe ? r.ceStrike : r.peStrike;
    const ltp = isCe ? r.ceLtp : r.peLtp;
    const macdVal = isCe ? r.ceMacd : r.peMacd;
    const fastEma = isCe ? r.ceMacdFastEma : r.peMacdFastEma;
    const slowEma = isCe ? r.ceMacdSlowEma : r.peMacdSlowEma;
    const isUp = macdVal >= 0;
    return `<tr>
      <td><div class="symbol">${safeText(r.underlying || r.symbol)}</div></td>
      <td><span class="sector-tag">${safeText(r.sector || 'Derivative')}</span></td>
      <td><span class="kind-tag ${r.kind === 'Index' ? 'index' : 'stock'}">${safeText(r.kind || 'Stock')}</span></td>
      <td><span class="watch-expiry">${safeText(formatDateDisplay(r.expiry))}</span></td>
      <td class="num">${fmt(strike, 0)} ${isCe ? 'CE' : 'PE'}</td>
      <td class="num">${fmt(ltp)}</td>
      <td class="num ${isUp ? 'macd-positive up' : 'macd-negative warn'}">${fmt(macdVal)}</td>
      <td class="num">${fmt(fastEma)}</td>
      <td class="num">${fmt(slowEma)}</td>
      <td>${isUp ? '<span class="signal up">▲ Bullish</span>' : '<span class="signal-red">▼ Bearish</span>'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="10" class="empty">No pairs currently meet this condition.</td></tr>';

  const sumEl = byId('strategySummary');
  if (sumEl) sumEl.textContent = `Showing ${filtered.length} strikes`;
}

// -------------------------------------------------------------
// Option Chain Loading & Strike Selection
// -------------------------------------------------------------
async function loadUniverse() {
  try {
    const res = await fetch('/api/universe');
    if (!res.ok) return;
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data.underlyings || []);
    universe = list;
    universeLoaded = true;

    // Populate Stocks
    const stockSelect = byId('underlyingSelect');
    if (stockSelect) {
      const stocks = list.filter(x => x.kind !== 'Index');
      stockSelect.innerHTML = '<option value="">Choose F&O Stock</option>' + stocks.map(x => `<option value="${safeText(x.key)}">${safeText(x.symbol)}</option>`).join('');
    }

    // Populate Indices
    const indexSelect = byId('indexUnderlyingSelect');
    if (indexSelect) {
      const indices = list.filter(x => x.kind === 'Index');
      indexSelect.innerHTML = '<option value="">Choose Index</option>' + indices.map(x => `<option value="${safeText(x.key)}">${safeText(x.symbol)}</option>`).join('');
    }
  } catch (err) {
    console.warn('Universe load failed:', err);
  }
}

async function chooseUnderlying(mode) {
  const ids = chainIds(mode);
  const select = byId(ids.underlying);
  const key = select?.value;
  const expirySelect = byId(ids.expiry);
  const loadBtn = byId(mode === 'indices' ? 'loadIndicesChain' : 'loadChain');

  if (!key) {
    if (expirySelect) { expirySelect.innerHTML = '<option value="">Choose underlying first</option>'; expirySelect.disabled = true; }
    if (loadBtn) loadBtn.disabled = true;
    return;
  }

  try {
    const res = await fetch(`/api/expiries?key=${encodeURIComponent(key)}`);
    if (!res.ok) return;
    const data = await res.json();
    if (expirySelect) {
      expirySelect.innerHTML = (data.expiries || []).map(exp => `<option value="${safeText(exp)}">${formatDateDisplay(exp)}</option>`).join('');
      expirySelect.disabled = false;
    }
    if (loadBtn) loadBtn.disabled = false;
    loadChain(mode);
  } catch (err) {
    console.warn('Expiries load failed:', err);
  }
}

const clientChainCache = new Map();

async function loadChain(mode) {
  const ids = chainIds(mode);
  const key = byId(ids.underlying)?.value;
  const expiry = byId(ids.expiry)?.value;
  const tbody = byId(ids.rows);

  if (!key || !expiry) return;
  const cacheKey = `${key}:${expiry}`;
  const cached = clientChainCache.get(cacheKey);

  if (cached && (Date.now() - cached.at) <= 25_000) {
    chainStates[mode].data = cached.chain;
    chainStates[mode].ce = null;
    chainStates[mode].pe = null;
    chainStates[mode]._hasScrolledToAtm = false;

    const spot = Number(cached.chain.last_price || 0);
    const spotLabel = byId(mode === 'indices' ? 'indicesMarketPrices' : 'stockMarketPrices');
    if (spotLabel && spot > 0) spotLabel.textContent = `Spot ${fmt(spot)}`;

    renderChainTable(mode);
    return;
  }

  if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="empty">Loading ${safeText(expiry)} option chain…</td></tr>`;

  try {
    const res = await fetch(`/api/option-chain?key=${encodeURIComponent(key)}&expiry=${encodeURIComponent(expiry)}`);
    if (!res.ok) throw new Error('Option chain error');
    const data = await res.json();
    const chain = data.chain || {};
    clientChainCache.set(cacheKey, { chain, at: Date.now() });

    chainStates[mode].data = chain;
    chainStates[mode].ce = null;
    chainStates[mode].pe = null;
    chainStates[mode]._hasScrolledToAtm = false;

    const spot = Number(chain.last_price || 0);
    const spotLabel = byId(mode === 'indices' ? 'indicesMarketPrices' : 'stockMarketPrices');
    if (spotLabel && spot > 0) spotLabel.textContent = `Spot ${fmt(spot)}`;

    renderChainTable(mode);
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="empty" style="color:var(--red)">Failed to load option chain. Ensure Dhan is connected.</td></tr>`;
  }
}

function renderChainTable(mode) {
  const ids = chainIds(mode);
  const tbody = byId(ids.rows);
  const chain = chainStates[mode].data;
  if (!tbody || !chain?.oc) return;

  const oc = chain.oc;
  const spot = Number(chain.last_price || 0);
  const strikes = [...new Set(Object.keys(oc).map(Number))].filter(n => Number.isFinite(n) && n > 0).sort((a,b) => a - b);

  if (!strikes.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty">No strikes available for this expiry.</td></tr>`;
    return;
  }

  // Find ATM
  let atmStrike = strikes[0];
  let minDiff = Math.abs(atmStrike - spot);
  for (const s of strikes) {
    const diff = Math.abs(s - spot);
    if (diff < minDiff) { minDiff = diff; atmStrike = s; }
  }

  // Display the FULL option chain (all strikes available from Dhan)
  const visible = strikes;

  let maxCallOi = 1, maxPutOi = 1;
  for (const s of visible) {
    const row = oc[s] || oc[String(s)] || oc[`${s}.000000`] || {};
    if (Number(row.ce?.oi) > maxCallOi) maxCallOi = Number(row.ce.oi);
    if (Number(row.pe?.oi) > maxPutOi) maxPutOi = Number(row.pe.oi);
  }

  tbody.innerHTML = visible.map(s => {
    const row = oc[s] || oc[String(s)] || oc[`${s}.000000`] || {};
    const ce = row.ce || {};
    const pe = row.pe || {};
    const isAtm = s === atmStrike;

    const callOiPct = Math.min(100, Math.round(((Number(ce.oi) || 0) / maxCallOi) * 100));
    const putOiPct = Math.min(100, Math.round(((Number(pe.oi) || 0) / maxPutOi) * 100));

    const isCeSel = chainStates[mode].ce === s;
    const isPeSel = chainStates[mode].pe === s;

    return `<tr class="${isAtm ? 'at-the-money' : ''}" ${isAtm ? `id="${mode}_atm_row"` : ''}>
      <td class="call-delta">${fmt(ce.delta ?? ce.greeks?.delta ?? 0.5, 2)}</td>
      <td>
        <label class="price-choice call">
          <input type="radio" name="${mode}_ce" value="${s}" ${isCeSel ? 'checked' : ''} />
          <span>${fmt(ce.last_price)}</span>
        </label>
      </td>
      <td class="oi-cell">
        <div class="oi-bar call" style="width:${callOiPct}%"></div>
        <span class="oi-value">${fmt(ce.oi || 0, 0)}</span>
      </td>
      <td class="strike-cell">
        <label class="strike-choice" title="Select both CE & PE at ${s} (Straddle)">
          <input type="radio" name="${mode}_both" value="${s}" ${isCeSel && isPeSel ? 'checked' : ''} />
          <b>${s}</b>
        </label>
      </td>
      <td class="neutral">${fmt(ce.implied_volatility ?? 15.5, 1)}</td>
      <td class="oi-cell">
        <div class="oi-bar put" style="width:${putOiPct}%"></div>
        <span class="oi-value">${fmt(pe.oi || 0, 0)}</span>
      </td>
      <td>
        <label class="price-choice put">
          <input type="radio" name="${mode}_pe" value="${s}" ${isPeSel ? 'checked' : ''} />
          <span>${fmt(pe.last_price)}</span>
        </label>
      </td>
      <td class="put-delta">${fmt(pe.delta ?? pe.greeks?.delta ?? -0.5, 2)}</td>
    </tr>`;
  }).join('');

  const summaryEl = byId(ids.summary);
  if (summaryEl) {
    summaryEl.textContent = `Showing full option chain (${visible.length} strikes) · ATM: ${atmStrike}`;
  }

  // Auto-scroll to center on ATM strike when option chain first loads
  if (!chainStates[mode]._hasScrolledToAtm) {
    chainStates[mode]._hasScrolledToAtm = true;
    setTimeout(() => {
      const atmRow = byId(`${mode}_atm_row`);
      if (atmRow) atmRow.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 60);
  }

  updateSelectionUI(mode);
}

function handleStrikeSelection(mode, event) {
  const target = event.target;
  if (!target || target.type !== 'radio') return;
  const strike = Number(target.value);

  if (target.name === `${mode}_both`) {
    chainStates[mode].ce = strike;
    chainStates[mode].pe = strike;
  } else if (target.name === `${mode}_ce`) {
    chainStates[mode].ce = strike;
  } else if (target.name === `${mode}_pe`) {
    chainStates[mode].pe = strike;
  }

  renderChainTable(mode);
}

function updateSelectionUI(mode) {
  const ids = chainIds(mode);
  const ce = chainStates[mode].ce;
  const pe = chainStates[mode].pe;
  const btn = byId(ids.add);
  const status = byId(ids.status);

  if (ce && pe) {
    if (btn) btn.disabled = false;
    const isSame = ce === pe;
    if (status) status.innerHTML = `Selected: <b>${ce} CE</b> + <b>${pe} PE</b> (${isSame ? 'Straddle' : 'Strangle'})`;
  } else if (ce || pe) {
    if (btn) btn.disabled = true;
    if (status) status.innerHTML = `Selected ${ce ? `${ce} CE` : `${pe} PE`} — select opposite leg`;
  } else {
    if (btn) btn.disabled = true;
    if (status) status.textContent = 'Select a call and a put';
  }
}

async function addPairToWatchlist(mode) {
  const ids = chainIds(mode);
  const key = byId(ids.underlying)?.value;
  const expiry = byId(ids.expiry)?.value;
  const ceStrike = chainStates[mode].ce;
  const peStrike = chainStates[mode].pe;

  if (!key || !expiry || !ceStrike || !peStrike) {
    toast('Select an underlying, expiry, call, and put strike.');
    return;
  }

  const btn = byId(ids.add);
  if (btn) btn.disabled = true;

  try {
    const res = await fetch('/api/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ underlyingKey: key, expiry, ceStrike, peStrike })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not add pair');
    toast(`Saved ${data.contract?.pairType || 'pair'} ${data.contract?.symbol || ''}`);
    await refreshState();
  } catch (err) {
    toast(err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function removeWatchlistPair(event) {
  const btn = event.target.closest('[data-remove]');
  if (!btn) return;
  const symbol = btn.dataset.remove;
  try {
    const res = await fetch(`/api/watchlist/${encodeURIComponent(symbol)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Could not remove');
    try {
      const localSaved = JSON.parse(localStorage.getItem('fixed_straddle_saved_contracts') || '[]');
      const updated = localSaved.filter(c => c.symbol !== symbol);
      localStorage.setItem('fixed_straddle_saved_contracts', JSON.stringify(updated));
    } catch {}
    toast(`Removed ${symbol}`);
    await refreshState();
  } catch (err) {
    toast(err.message);
  }
}

// -------------------------------------------------------------
// Settings & Dhan Connection
// -------------------------------------------------------------
function strategySettingsPayload() {
  const indexStraddle = Number(byId('indexStraddleTimeframe')?.value || byId('indexTimeframe')?.value || 5);
  const indexStrangle = Number(byId('indexStrangleTimeframe')?.value || 1);
  const stockStraddle = Number(byId('stockStraddleTimeframe')?.value || byId('stockTimeframe')?.value || 15);
  const stockStrangle = Number(byId('stockStrangleTimeframe')?.value || 5);
  return {
    indexStraddleTimeframe: indexStraddle,
    indexStrangleTimeframe: indexStrangle,
    stockStraddleTimeframe: stockStraddle,
    stockStrangleTimeframe: stockStrangle,
    stockTimeframe: stockStraddle,
    indexTimeframe: indexStraddle,
    macdFast: Number(byId('macdFast')?.value || 12),
    macdSlow: Number(byId('macdSlow')?.value || 26),
    macdSignal: Number(byId('macdSignal')?.value || 9),
    emaPeriod: Number(byId('emaPeriod')?.value || 200)
  };
}

async function saveStrategySettings(message = 'Strategy settings saved.') {
  const res = await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(strategySettingsPayload())
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to save settings');
  toast(message);
}

function telegramSettingsPayload() {
  return {
    telegramEnabled: Boolean(byId('telegramEnabled')?.checked),
    telegramBotToken: (byId('telegramBotToken')?.value || '').trim(),
    telegramChatId: (byId('telegramChatId')?.value || '').trim(),
    telegramAlertThree: Boolean(byId('telegramAlertThree')?.checked),
    telegramAlertFive: Boolean(byId('telegramAlertFive')?.checked),
    eodTelegramReport: Boolean(byId('eodTelegramReport')?.checked)
  };
}

async function triggerTelegramTest(mode = 'test', btnId) {
  const payload = { ...telegramSettingsPayload(), mode };
  const btn = byId(btnId);
  const msgEl = byId('telegramMessage');
  if (btn) btn.disabled = true;
  if (msgEl) msgEl.textContent = 'Sending message to Telegram…';
  try {
    const res = await fetch('/api/telegram/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to send');
    if (msgEl) msgEl.textContent = data.message || 'Telegram test message delivered!';
    toast(data.message || 'Telegram delivered!');
  } catch (err) {
    if (msgEl) msgEl.textContent = err.message;
    toast(err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// -------------------------------------------------------------
// State Polling & DOM Sync
// -------------------------------------------------------------
let isRefreshingState = false;

async function refreshState() {
  if (isRefreshingState) return;
  isRefreshingState = true;

  try {
    const res = await fetch('/api/state');
    if (!res.ok) throw new Error('State error');
    const data = await res.json();
    state = data;

    // Header metrics
    const totalPairs = (data.contracts || []).length;
    const signalsCount = (data.contracts || []).filter(c => c.alert > 0).length;
    const fiveStarCount = (data.contracts || []).filter(c => c.alert === 5).length;

    // -------------------------------------------------------------
    // Auto-Restore & LocalStorage Persistence for Pairs
    // -------------------------------------------------------------
    if (Array.isArray(data.contracts) && data.contracts.length > 0) {
      try {
        localStorage.setItem('fixed_straddle_saved_contracts', JSON.stringify(data.contracts));
      } catch (e) {}
    } else if (Array.isArray(data.contracts) && data.contracts.length === 0 && !window._hasRestoredContracts) {
      try {
        const localSaved = JSON.parse(localStorage.getItem('fixed_straddle_saved_contracts') || '[]');
        if (Array.isArray(localSaved) && localSaved.length > 0) {
          window._hasRestoredContracts = true;
          console.log(`Auto-restoring ${localSaved.length} saved straddle/strangle pairs from local storage…`);
          fetch('/api/watchlist/sync-batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contracts: localSaved })
          }).then(() => refreshState());
        }
      } catch (e) {}
    }

    // -------------------------------------------------------------
    // Auto-Restore & LocalStorage Persistence for Dhan Credentials
    // -------------------------------------------------------------
    if (data.configured) {
      try {
        const creds = {
          clientId: byId('dhanClientId')?.value || data.clientId || '1100616877',
          pin: byId('dhanPin')?.value || '172711',
          totpSecret: byId('dhanTotpSecret')?.value || '4KCM2ASGEDJBC6R2RO63EKLMLXN7WYNC'
        };
        localStorage.setItem('fixed_straddle_dhan_creds', JSON.stringify(creds));
      } catch (e) {}
    } else if (!data.configured && !window._hasAutoRestoredDhan) {
      try {
        const creds = JSON.parse(localStorage.getItem('fixed_straddle_dhan_creds') || '{}');
        const clientId = creds.clientId || byId('dhanClientId')?.value || '1100616877';
        const pin = creds.pin || byId('dhanPin')?.value || '172711';
        const totpSecret = creds.totpSecret || byId('dhanTotpSecret')?.value || '4KCM2ASGEDJBC6R2RO63EKLMLXN7WYNC';
        if (clientId && pin && totpSecret) {
          window._hasAutoRestoredDhan = true;
          console.log('Auto-restoring Dhan TOTP login from local storage…');
          fetch('/api/dhan/totp-login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientId, pin, totpSecret })
          }).then(() => refreshState());
        }
      } catch (e) {}
    }

    if (byId('universeCount')) byId('universeCount').innerHTML = `${totalPairs}<span class="metric-foot">monitored</span>`;
    if (byId('signalCount')) byId('signalCount').innerHTML = `${signalsCount}<span class="metric-foot">qualifying</span>`;
    if (byId('fiveCount')) byId('fiveCount').innerHTML = `${fiveStarCount}<span class="metric-foot">5★ alerts</span>`;

    const connected = Boolean(data.connected);
    const connState = byId('connectionState');
    if (connState) {
      connState.textContent = connected ? 'Live feed active' : data.configured ? 'Connected (waiting for feed)' : 'Not connected';
      connState.className = `metric-value ${connected ? 'up' : 'warn'}`;
    }

    const dot = byId('statusDot');
    if (dot) dot.style.background = connected ? 'var(--mint)' : 'var(--amber)';

    const mkt = byId('marketStatus');
    if (mkt) mkt.textContent = connected ? 'Market feed active' : data.configured ? 'Dhan authenticated' : 'Connect Dhan account';

    const modeTag = byId('modeTag');
    if (modeTag) modeTag.textContent = connected ? 'LIVE' : 'IDLE';

    // Dhan status card & input values
    if (data.configured) {
      if (byId('dhanConnectedCard')) byId('dhanConnectedCard').style.display = 'block';
      if (byId('dhanLoginFormContainer') && !window._editingDhanCredentials) byId('dhanLoginFormContainer').style.display = 'none';
      if (byId('connectedClientId')) byId('connectedClientId').textContent = data.clientId || '1100616877';
      if (byId('connectedTokenExpiry')) byId('connectedTokenExpiry').textContent = data.tokenValidity ? `Valid until ${data.tokenValidity}` : 'Active';
    } else {
      if (byId('dhanConnectedCard')) byId('dhanConnectedCard').style.display = 'none';
      if (byId('dhanLoginFormContainer')) byId('dhanLoginFormContainer').style.display = 'block';
    }

    // Populate Settings fields if not yet touched
    if (data.settings) {
      const tfFields = {
        stockTimeframe: 'stockTimeframe',
        indexTimeframe: 'indexTimeframe',
        stockStraddleTimeframe: 'stockStraddleTimeframe',
        stockStrangleTimeframe: 'stockStrangleTimeframe',
        indexStraddleTimeframe: 'indexStraddleTimeframe',
        indexStrangleTimeframe: 'indexStrangleTimeframe',
        macdFast: 'macdFast',
        macdSlow: 'macdSlow',
        macdSignal: 'macdSignal',
        emaPeriod: 'emaPeriod'
      };
      for (const [key, id] of Object.entries(tfFields)) {
        const el = byId(id);
        if (el && data.settings[key] && !el._focused) el.value = data.settings[key];
      }

      if (byId('telegramEnabled')) byId('telegramEnabled').checked = Boolean(data.settings.telegramEnabled ?? true);
      if (byId('telegramBotToken') && !byId('telegramBotToken').value) byId('telegramBotToken').value = data.settings.telegramBotToken || '';
      if (byId('telegramChatId') && !byId('telegramChatId').value) byId('telegramChatId').value = data.settings.telegramChatId || '';
      if (byId('telegramAlertThree')) byId('telegramAlertThree').checked = Boolean(data.settings.telegramAlertThree ?? true);
      if (byId('telegramAlertFive')) byId('telegramAlertFive').checked = Boolean(data.settings.telegramAlertFive ?? true);
      if (byId('eodTelegramReport')) byId('eodTelegramReport').checked = Boolean(data.settings.eodTelegramReport ?? true);
    }

    if (byId('eodAlertCountBadge')) {
      const count = data.todayAlertsCount || 0;
      byId('eodAlertCountBadge').textContent = `${count} alert${count === 1 ? '' : 's'} logged today`;
    }

    // Load Universe if connected
    if (data.configured && !universeLoaded) {
      await loadUniverse();
    }

    // Render Contracts
    renderWatchlist(data.contracts || []);

  } catch (err) {
    console.warn('refreshState failed:', err);
  } finally {
    isRefreshingState = false;
  }
}

// -------------------------------------------------------------
// Navigation & Page Switching
// -------------------------------------------------------------
function setupNavigation() {
  const pages = ['alertsPage', 'indicesPage', 'watchlistPage', 'apiSettingsPage', 'strategyPage'];
  const titles = {
    alertsPage: { title: 'Live straddle alerts', desc: 'Real-time alerts meeting your specific Straddle and Strangle timeframe rules.' },
    indicesPage: { title: 'Indices workspace', desc: 'Browse Index option chains and monitor custom Index Straddles and Strangles.' },
    watchlistPage: { title: 'F&O Stocks workspace', desc: 'Select individual F&O stock options to build custom fixed straddles and strangles.' },
    apiSettingsPage: { title: 'API & Strategy Settings', desc: 'Configure Dhan TOTP auto-connect, specific timeframes, and Telegram notifications.' },
    strategyPage: { title: 'MACD Momentum Strategy', desc: 'Option strike momentum views based on MACD zero line crossings.' }
  };

  function showPage(pageId) {
    pages.forEach(p => {
      const el = byId(p);
      if (el) el.hidden = p !== pageId;
    });

    document.querySelectorAll('[data-page-link]').forEach(a => {
      const target = a.dataset.pageLink;
      a.classList.toggle('active', target === pageId);
    });

    const info = titles[pageId] || titles.alertsPage;
    if (byId('pageTitle')) byId('pageTitle').textContent = info.title;
    if (byId('pageDescription')) byId('pageDescription').textContent = info.desc;
  }

  document.querySelectorAll('[data-page-link]').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      const pageId = a.dataset.pageLink;
      if (a.dataset.strategy) {
        activeStrategyTab = a.dataset.strategy;
        document.querySelectorAll('.strategy-card, .strategy-nav-item').forEach(el => {
          el.classList.toggle('active', el.dataset.strategy === activeStrategyTab);
        });
        renderStrategyViews();
      }
      showPage(pageId);
    });
  });

  document.querySelectorAll('.strategy-card').forEach(card => {
    card.addEventListener('click', () => {
      activeStrategyTab = card.dataset.strategy;
      document.querySelectorAll('.strategy-card, .strategy-nav-item').forEach(el => {
        el.classList.toggle('active', el.dataset.strategy === activeStrategyTab);
      });
      renderStrategyViews();
    });
  });

  // Nav Submenu Toggles
  byId('futureOptionToggle')?.addEventListener('click', () => {
    const menu = byId('futureOptionMenu');
    const btn = byId('futureOptionToggle');
    if (menu) {
      const isOpen = !menu.hidden;
      menu.hidden = isOpen;
      btn?.setAttribute('aria-expanded', String(!isOpen));
    }
  });

  // Initial page from hash
  const hash = window.location.hash.replace(/^#/, '');
  if (pages.includes(hash)) showPage(hash);
  else showPage('alertsPage');
}

// -------------------------------------------------------------
// Event Listeners Initialization
// -------------------------------------------------------------
function setupEventListeners() {
  // Option chain selects
  byId('underlyingSelect')?.addEventListener('change', () => chooseUnderlying('stocks'));
  byId('expirySelect')?.addEventListener('change', () => loadChain('stocks'));
  byId('loadChain')?.addEventListener('click', () => loadChain('stocks'));

  byId('indexUnderlyingSelect')?.addEventListener('change', () => chooseUnderlying('indices'));
  byId('indicesExpirySelect')?.addEventListener('change', () => loadChain('indices'));
  byId('loadIndicesChain')?.addEventListener('click', () => loadChain('indices'));

  // Option chain strike selection
  byId('chainRows')?.addEventListener('change', e => handleStrikeSelection('stocks', e));
  byId('indicesChainRows')?.addEventListener('change', e => handleStrikeSelection('indices', e));

  // Add pair buttons
  byId('addWatchlist')?.addEventListener('click', () => addPairToWatchlist('stocks'));
  byId('addIndexWatchlist')?.addEventListener('click', () => addPairToWatchlist('indices'));

  // Remove watchlist pairs
  byId('scannerRows')?.addEventListener('click', removeWatchlistPair);
  byId('indexScannerRows')?.addEventListener('click', removeWatchlistPair);

  // Filters & Searches
  byId('search')?.addEventListener('input', () => renderWatchlist(liveRows));
  byId('signalFilter')?.addEventListener('change', () => renderWatchlist(liveRows));
  byId('indexSearch')?.addEventListener('input', () => renderWatchlist(liveRows));
  byId('indexSignalFilter')?.addEventListener('change', () => renderWatchlist(liveRows));
  byId('alertLevelFilter')?.addEventListener('change', renderAlerts);

  // Settings saving
  byId('saveSettings')?.addEventListener('click', async () => {
    try {
      await saveStrategySettings('Signal & timeframe settings saved.');
      await refreshState();
    } catch (err) {
      toast(err.message);
    }
  });

  // Telegram settings
  byId('saveTelegramSettings')?.addEventListener('click', async () => {
    const payload = telegramSettingsPayload();
    const msgEl = byId('telegramMessage');
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save');
      if (msgEl) msgEl.textContent = 'Telegram settings saved!';
      toast('Telegram settings saved.');
    } catch (err) {
      if (msgEl) msgEl.textContent = err.message;
      toast(err.message);
    }
  });

  byId('testTelegramBtn')?.addEventListener('click', () => triggerTelegramTest('test', 'testTelegramBtn'));
  byId('testTelegramAlertBtn')?.addEventListener('click', () => triggerTelegramTest('sampleFive', 'testTelegramAlertBtn'));

  // EOD Excel / CSV downloads
  byId('btnDownloadExcel')?.addEventListener('click', () => {
    window.location.href = '/api/reports/download?format=xlsx';
  });
  byId('btnDownloadCsv')?.addEventListener('click', () => {
    window.location.href = '/api/reports/download?format=csv';
  });
  byId('btnSendTelegramReport')?.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/reports/dispatch-telegram', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Dispatch failed');
      toast(data.message || 'Report sent to Telegram!');
    } catch (err) {
      toast(err.message);
    }
  });
  byId('sendEodTelegramNowBtn')?.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/reports/dispatch-telegram', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Dispatch failed');
      toast(data.message || 'Report sent to Telegram!');
    } catch (err) {
      toast(err.message);
    }
  });

  // Dhan Auth Tabs & Form Toggle
  byId('tabTotpAuth')?.addEventListener('click', () => {
    byId('totpAuthSection').hidden = false;
    byId('manualAuthSection').hidden = true;
    byId('tabTotpAuth').style.color = 'var(--mint)';
    byId('tabTotpAuth').style.borderBottom = '2px solid var(--mint)';
    byId('tabManualAuth').style.color = 'var(--muted)';
    byId('tabManualAuth').style.borderBottom = 'none';
  });

  byId('tabManualAuth')?.addEventListener('click', () => {
    byId('totpAuthSection').hidden = true;
    byId('manualAuthSection').hidden = false;
    byId('tabManualAuth').style.color = 'var(--mint)';
    byId('tabManualAuth').style.borderBottom = '2px solid var(--mint)';
    byId('tabTotpAuth').style.color = 'var(--muted)';
    byId('tabTotpAuth').style.borderBottom = 'none';
  });

  byId('toggleCredentialsForm')?.addEventListener('click', () => {
    window._editingDhanCredentials = !window._editingDhanCredentials;
    const form = byId('dhanLoginFormContainer');
    if (form) form.style.display = window._editingDhanCredentials ? 'block' : 'none';
  });

  // Dhan Login Buttons
  byId('loginDhanTotp')?.addEventListener('click', async () => {
    const clientId = (byId('dhanClientId')?.value || '').trim();
    const pin = (byId('dhanPin')?.value || '').trim();
    const totpSecret = (byId('dhanTotpSecret')?.value || '').trim();
    const autoRefresh = Boolean(byId('autoTotpRefresh')?.checked ?? true);
    const msg = byId('credentialMessage');

    if (!clientId || !pin || !totpSecret) {
      if (msg) msg.textContent = 'Please enter Client ID, 6-digit PIN, and TOTP Secret.';
      toast('Fill Client ID, PIN, and TOTP Secret');
      return;
    }

    if (msg) msg.textContent = 'Generating TOTP and logging in to Dhan…';
    const btn = byId('loginDhanTotp');
    if (btn) btn.disabled = true;

    try {
      const res = await fetch('/api/dhan/totp-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, pin, totpSecret, autoRefresh })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');
      toast('Connected to Dhan via TOTP!');
      universeLoaded = false;
      await refreshState();
    } catch (err) {
      if (msg) msg.textContent = err.message;
      toast(err.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  byId('connectDhan')?.addEventListener('click', async () => {
    const clientId = (byId('dhanClientId')?.value || '').trim();
    const accessToken = (byId('dhanAccessToken')?.value || '').trim();
    const msg = byId('credentialMessage');
    if (!clientId || !accessToken) {
      if (msg) msg.textContent = 'Enter both Client ID and Access Token.';
      return;
    }
    const btn = byId('connectDhan');
    if (btn) btn.disabled = true;
    try {
      const res = await fetch('/api/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, accessToken })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Connection failed');
      toast('Dhan connected with manual token!');
      universeLoaded = false;
      await refreshState();
    } catch (err) {
      if (msg) msg.textContent = err.message;
      toast(err.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  byId('disconnectDhan')?.addEventListener('click', async () => {
    try {
      await fetch('/api/disconnect', { method: 'POST' });
      toast('Dhan disconnected.');
      await refreshState();
    } catch (err) {
      toast('Failed to disconnect');
    }
  });

  byId('syncUniverse')?.addEventListener('click', async () => {
    try {
      toast('Refreshing F&O list…');
      await fetch('/api/universe/sync', { method: 'POST' });
      universeLoaded = false;
      setTimeout(loadUniverse, 800);
    } catch (err) {
      toast('Failed to refresh universe');
    }
  });
}

// -------------------------------------------------------------
// Clock & Boot
// -------------------------------------------------------------
function updateTodayClock() {
  const el = byId('today');
  if (!el) return;
  const now = new Date();
  const time = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: true
  }).format(now);
  el.textContent = `${time} IST`;
}

async function boot() {
  updateTodayClock();
  setInterval(updateTodayClock, 1000);
  setupNavigation();
  setupEventListeners();
  await refreshState();
  setInterval(refreshState, 3000);
}

document.addEventListener('DOMContentLoaded', boot);
