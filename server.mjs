import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {}
const PORT = Number(process.env.PORT || 3000);
const CONFIG_FILE = path.join(ROOT, 'scanner.config.json');
const SETTINGS_FILE = path.join(ROOT, 'scanner.settings.json');
const STATE_FILE = path.join(ROOT, 'market-state.json');
const UNIVERSE_FILE = path.join(ROOT, 'fno-universe.json');
const STOCKS_FILE = path.join(ROOT, 'nse-stocks.json');
const REPORTS_DIR = path.join(ROOT, 'reports');
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
const ALERTS_HISTORY_FILE = path.join(REPORTS_DIR, 'alerts-history.json');
let alertsHistory = loadJson(ALERTS_HISTORY_FILE, []);
const TZ_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const config = loadJson(CONFIG_FILE, { contracts: [] });
let settings = loadJson(SETTINGS_FILE, {
  strikeCount: 3, stockTimeframe: 15, indexTimeframe: 5,
  indexStraddleTimeframe: 5, indexStrangleTimeframe: 1,
  stockStraddleTimeframe: 15, stockStrangleTimeframe: 5,
  macdFast: 12, macdSlow: 26, macdSignal: 9, emaPeriod: 200,
  telegramEnabled: true, telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '9066894671:AAF0y0eoWlddAlmE1EfDdyDkx33U2f33f7g', telegramChatId: process.env.TELEGRAM_CHAT_ID || '723433781',
  telegramAlertThree: true, telegramAlertFive: true,
  dhanClientId: '1100616877', dhanPin: '172711', dhanTotpSecret: '4KCM2ASGEDJBC6R2RO63EKLMLXN7WYNC',
  dhanAccessToken: '',
  autoTotpRefresh: true,
  eodTelegramReport: true
});
settings.dhanClientId ||= '1100616877';
settings.dhanPin ||= '172711';
settings.dhanTotpSecret ||= '4KCM2ASGEDJBC6R2RO63EKLMLXN7WYNC';

let dhanCredentials = {
  clientId: process.env.DHAN_CLIENT_ID || settings.dhanClientId || '1100616877',
  accessToken: process.env.DHAN_ACCESS_TOKEN || settings.dhanAccessToken || '',
  pin: process.env.DHAN_PIN || settings.dhanPin || '172711',
  totpSecret: process.env.DHAN_TOTP_SECRET || settings.dhanTotpSecret || '4KCM2ASGEDJBC6R2RO63EKLMLXN7WYNC',
  tokenExpiry: null
};
settings.indexStrangleTimeframe = Number(settings.indexStrangleTimeframe) || 1;
settings.indexStraddleTimeframe = Number(settings.indexStraddleTimeframe || settings.indexTimeframe) || 5;
settings.stockStrangleTimeframe = Number(settings.stockStrangleTimeframe) || 5;
settings.stockStraddleTimeframe = Number(settings.stockStraddleTimeframe || settings.stockTimeframe) || 15;
settings.stockTimeframe = settings.stockStraddleTimeframe;
settings.indexTimeframe = settings.indexStraddleTimeframe;
settings.telegramEnabled ??= true;
settings.telegramBotToken ||= process.env.TELEGRAM_BOT_TOKEN || '9066894671:AAF0y0eoWlddAlmE1EfDdyDkx33U2f33f7g';
settings.telegramChatId ||= process.env.TELEGRAM_CHAT_ID || '723433781';
settings.telegramAlertThree ??= true;
settings.telegramAlertFive ??= true;
settings.autoTotpRefresh ??= true;
settings.eodTelegramReport ??= true;
delete settings.timeframe;
const state = loadJson(STATE_FILE, { feed: 'disconnected', updatedAt: null, contracts: {}, indicatorVersion: 10 });
if (state.indicatorVersion !== 10) {
  for (const saved of Object.values(state.contracts || {})) { saved.macd = null; saved.macdFastEma = null; saved.macdSlowEma = null; saved.ema = null; saved.alert = 0; saved.indicatorBars = 0; saved.macdReady = false; saved.emaReady = false; saved.indicatorError = null; saved.status = 'warming-up'; }
  state.indicatorVersion = 10;
  saveJson(STATE_FILE, state);
}
let fnoUniverse = loadJson(UNIVERSE_FILE, []);
let stockUniverse = loadJson(STOCKS_FILE, []);
if(!Array.isArray(stockUniverse))stockUniverse=[];
let underlyingPriceState = {};
let stockEmaState = {};
let stockEmaRefreshPromise = null;
let stockEmaLastRefreshDay = null;
let stockEmaScan = {status:'not-started',done:0,total:0,alerts:0,errors:0,updatedAt:null};
const candles = new Map();
// Last known option-leg marks are carried only within the same Indian trading day.
// This keeps a synthetic straddle candle available when one leg has no tick in a bucket.
const legMarks = new Map();
let socket = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let lastError = null;
let universeSync = { status: 'not-started', total: 0, done: 0, errors: [] };
let dhanRequestQueue = Promise.resolve();
let lastDhanRequestAt = 0;
let lastOptionChainAt = 0;
let optionChainQueue = Promise.resolve();

function loadJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function saveJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2)); }
let stateSaveTimer = null;
function saveStateDebounced() {
  if (stateSaveTimer) return;
  stateSaveTimer = setTimeout(() => {
    stateSaveTimer = null;
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (err) { console.error('Failed to save state:', err.message); }
  }, 400);
}
function flushStateSync() {
  if (stateSaveTimer) {
    clearTimeout(stateSaveTimer);
    stateSaveTimer = null;
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch {}
  }
}
let alertsSaveTimer = null;
function saveAlertsDebounced() {
  if (alertsSaveTimer) return;
  alertsSaveTimer = setTimeout(() => {
    alertsSaveTimer = null;
    try { fs.writeFileSync(ALERTS_HISTORY_FILE, JSON.stringify(alertsHistory, null, 2)); } catch (err) { console.error('Failed to save alerts history:', err.message); }
  }, 500);
}

function base32Decode(base32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = String(base32 || '').toUpperCase().replace(/[\s=-]/g, '');
  let bits = '';
  const bytes = [];
  for (let i = 0; i < cleaned.length; i++) {
    const val = alphabet.indexOf(cleaned[i]);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function generateTOTP(secret, step = 30) {
  if (!secret) return null;
  try {
    const key = base32Decode(secret);
    if (!key.length) return null;
    const counter = Math.floor(Date.now() / 1000 / step);
    const buf = Buffer.alloc(8);
    buf.writeBigInt64BE(BigInt(counter));
    const hmac = crypto.createHmac('sha1', key).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const binary = ((hmac[offset] & 0x7f) << 24) |
                   ((hmac[offset + 1] & 0xff) << 16) |
                   ((hmac[offset + 2] & 0xff) << 8) |
                   (hmac[offset + 3] & 0xff);
    return String(binary % 1000000).padStart(6, '0');
  } catch (err) {
    console.error('TOTP generation error:', err.message);
    return null;
  }
}

function saveEnvCredentials() {
  try {
    const envPath = path.join(ROOT, '.env');
    let content = '';
    try { content = fs.readFileSync(envPath, 'utf8'); } catch {}
    const map = new Map();
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx !== -1) map.set(trimmed.slice(0, idx).trim(), trimmed.slice(idx + 1).trim());
    }
    map.set('DHAN_CLIENT_ID', dhanCredentials.clientId || '');
    if (dhanCredentials.pin) map.set('DHAN_PIN', dhanCredentials.pin);
    if (dhanCredentials.totpSecret) map.set('DHAN_TOTP_SECRET', dhanCredentials.totpSecret);
    if (dhanCredentials.accessToken) map.set('DHAN_ACCESS_TOKEN', dhanCredentials.accessToken);
    map.set('PORT', String(PORT));
    if (settings.telegramBotToken) map.set('TELEGRAM_BOT_TOKEN', settings.telegramBotToken);
    if (settings.telegramChatId) map.set('TELEGRAM_CHAT_ID', settings.telegramChatId);

    const out = [
      '# Dhan API credentials',
      `DHAN_CLIENT_ID=${map.get('DHAN_CLIENT_ID') || ''}`,
      `DHAN_PIN=${map.get('DHAN_PIN') || ''}`,
      `DHAN_TOTP_SECRET=${map.get('DHAN_TOTP_SECRET') || ''}`,
      `DHAN_ACCESS_TOKEN=${map.get('DHAN_ACCESS_TOKEN') || ''}`,
      `PORT=${PORT}`,
      '',
      '# Telegram Alert Bot',
      `TELEGRAM_BOT_TOKEN=${map.get('TELEGRAM_BOT_TOKEN') || ''}`,
      `TELEGRAM_CHAT_ID=${map.get('TELEGRAM_CHAT_ID') || ''}`
    ].join('\n');
    fs.writeFileSync(envPath, out + '\n');
  } catch (err) {
    console.error('Failed to update .env:', err.message);
  }
}

async function loginWithDhanTotp(clientId, pin, totpSecret) {
  clientId = String(clientId || dhanCredentials.clientId || '').trim();
  pin = String(pin || dhanCredentials.pin || '').trim();
  totpSecret = String(totpSecret || dhanCredentials.totpSecret || '').trim();

  if (!clientId || !pin || !totpSecret) {
    return { ok: false, error: 'Dhan Client ID, 6-digit PIN, and TOTP Secret Key are required.' };
  }
  const totpCode = generateTOTP(totpSecret);
  if (!totpCode) {
    return { ok: false, error: 'Could not generate TOTP code. Please verify your TOTP Secret Key.' };
  }

  const url = `https://auth.dhan.co/app/generateAccessToken?dhanClientId=${encodeURIComponent(clientId)}&pin=${encodeURIComponent(pin)}&totp=${encodeURIComponent(totpCode)}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(10000)
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.status === 'error' || data.status === 'failure' || !data.accessToken) {
      const errMsg = data.errorMessage || data.message || data.error || (data.status === 'error' ? 'Dhan authentication failed' : `Dhan auth failed (HTTP ${res.status})`);
      return { ok: false, error: errMsg };
    }

    dhanCredentials.clientId = clientId;
    dhanCredentials.accessToken = data.accessToken;
    dhanCredentials.pin = pin;
    dhanCredentials.totpSecret = totpSecret;
    dhanCredentials.tokenExpiry = data.expiryTime || null;

    settings.dhanClientId = clientId;
    settings.dhanAccessToken = data.accessToken;
    settings.dhanPin = pin;
    settings.dhanTotpSecret = totpSecret;
    saveJson(SETTINGS_FILE, settings);

    lastError = null;
    saveEnvCredentials();
    refreshFeedSubscriptions();
    void syncFnoUniverse();
    void warmupWatchlist();

    const expiryLabel = data.expiryTime ? new Date(data.expiryTime).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '24 hours';
    console.log(`Dhan auto-login via TOTP successful! Token active until ${expiryLabel}.`);

    if (settings.telegramEnabled && settings.telegramBotToken && settings.telegramChatId) {
      const msg = `🔐 <b>Dhan Auto-Login Successful</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `<b>Client ID:</b> ${clientId}\n` +
        `<b>Method:</b> TOTP Auto-Authentication\n` +
        `<b>Token Valid Until:</b> ${expiryLabel} IST\n` +
        `<b>Market Feed:</b> Connected & Scanning live\n` +
        `━━━━━━━━━━━━━━━━━━━━`;
      queueTelegramAlert(settings.telegramBotToken, settings.telegramChatId, msg);
    }

    return {
      ok: true,
      clientId,
      clientName: data.dhanClientName || null,
      tokenValidity: expiryLabel,
      message: `Dhan connected via TOTP! Token active until ${expiryLabel}.`
    };
  } catch (err) {
    console.error('Dhan TOTP login error:', err.message);
    return { ok: false, error: `Connection failed: ${err.message}` };
  }
}

let lastTotpAttemptAt = 0;
setInterval(async () => {
  if (!settings.autoTotpRefresh) return;
  if (!dhanCredentials.pin || !dhanCredentials.totpSecret || !dhanCredentials.clientId) return;

  const now = new Date();
  const indiaNow = new Date(now.getTime() + TZ_OFFSET_MS);
  const hours = indiaNow.getUTCHours();
  const minutes = indiaNow.getUTCMinutes();
  const isMorningSlot = hours === 8 && minutes >= 30 && minutes <= 40;
  const isWeekday = indiaNow.getUTCDay() >= 1 && indiaNow.getUTCDay() <= 5;
  const isExpiredOrExpiringSoon = !dhanCredentials.accessToken || (dhanCredentials.tokenExpiry && new Date(dhanCredentials.tokenExpiry).getTime() - Date.now() < 2 * 3600_000);

  if ((isWeekday && isMorningSlot) || isExpiredOrExpiringSoon) {
    if (Date.now() - lastTotpAttemptAt > 15 * 60_000) {
      lastTotpAttemptAt = Date.now();
      console.log('Initiating automatic daily Dhan token refresh via TOTP…');
      await loginWithDhanTotp(dhanCredentials.clientId, dhanCredentials.pin, dhanCredentials.totpSecret);
    }
  }
}, 60_000).unref();
function configured() { return Boolean(dhanCredentials.clientId && dhanCredentials.accessToken); }
function isStrangle(contract) {
  if (!contract) return false;
  const ceStrike = Number(contract.ce?.strike ?? contract.ceStrike);
  const peStrike = Number(contract.pe?.strike ?? contract.peStrike);
  return Number.isFinite(ceStrike) && Number.isFinite(peStrike) && ceStrike !== peStrike;
}
function timeframeFor(contract) {
  if (!contract) return 15;
  const isIdx = contract.kind === 'Index' || String(contract.kind || '').toLowerCase() === 'index';
  const strangle = isStrangle(contract);
  if (isIdx) {
    return strangle
      ? (Number(settings.indexStrangleTimeframe) || 1)
      : (Number(settings.indexStraddleTimeframe) || Number(settings.indexTimeframe) || 5);
  } else {
    return strangle
      ? (Number(settings.stockStrangleTimeframe) || 5)
      : (Number(settings.stockStraddleTimeframe) || Number(settings.stockTimeframe) || 15);
  }
}
function candleBucketStart(epochMs, timeframeMinutes) {
  const localMs = epochMs + TZ_OFFSET_MS;
  const local = new Date(localMs);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const sessionOpen = midnight + (9 * 60 + 15) * 60_000;
  // Intraday candles are anchored to the NSE session open (09:15 IST),
  // not midnight. This matters for 2/30/60+ minute custom intervals.
  const anchor = localMs >= sessionOpen ? sessionOpen : midnight;
  return Math.floor((localMs - anchor) / (timeframeMinutes * 60_000)) * timeframeMinutes * 60_000 + anchor - TZ_OFFSET_MS;
}
function allowedLocalOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const originHost = new URL(origin).host;
    const reqHost = req.headers.host;
    if (originHost === reqHost) return true;
    if (originHost.startsWith('localhost') || originHost.startsWith('127.0.0.1')) return true;
    if (originHost.endsWith('.onrender.com')) return true;
  } catch {}
  return origin === `http://127.0.0.1:${PORT}` || origin === `http://localhost:${PORT}`;
}
function json(res, status, value) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); }
async function requestJson(req, maxBytes=20_000) {
  let body=''; for await (const chunk of req) { body+=chunk; if (body.length>maxBytes) throw new Error('Request too large'); }
  return JSON.parse(body || '{}');
}
function validLeg(leg) { return leg && /^[0-9]+$/.test(String(leg.securityId)) && typeof leg.exchangeSegment === 'string'; }
function validContract(c) { return c && c.source === 'manual' && typeof c.symbol === 'string' && typeof c.expiry === 'string' && validLeg(c.ce) && validLeg(c.pe); }
function pruneExpiredContracts() {
  const todayInIndia = new Date(Date.now() + TZ_OFFSET_MS).toISOString().slice(0, 10);
  const expired = config.contracts.filter(c => validContract(c) && /^\d{4}-\d{2}-\d{2}/.test(String(c.expiry || '').trim()) && String(c.expiry).trim().slice(0, 10) < todayInIndia);
  if (!expired.length) return false;
  const expiredSymbols = new Set(expired.map(c => c.symbol));
  config.contracts = config.contracts.filter(c => !expiredSymbols.has(c.symbol));
  for (const symbol of expiredSymbols) { delete state.contracts[symbol]; candles.delete(symbol); }
  saveJson(CONFIG_FILE, config);
  saveJson(STATE_FILE, state);
  refreshFeedSubscriptions();
  console.log(`Removed ${expiredSymbols.size} custom straddle(s) after expiry.`);
  return true;
}
function instruments() {
  const all = [];
  for (const c of config.contracts) {
    if (!validContract(c)) continue;
    all.push(c.ce, c.pe);
  }
  for(const item of fnoUniverse){
    if(item.market?.spotSecurityId)all.push({exchangeSegment:item.market.spotExchangeSegment,securityId:item.market.spotSecurityId});
    if(item.market?.futureSecurityId)all.push({exchangeSegment:'NSE_FNO',securityId:item.market.futureSecurityId});
  }
  return [...new Map(all.filter(validLeg).map(i => [`${i.exchangeSegment}:${i.securityId}`, i])).values()];
}
function updateUnderlyingPrice(instrument,price){
  if(!Number.isFinite(price)||price<=0)return;
  for(const item of fnoUniverse){const market=item.market;if(!market)continue;
    if(String(market.spotSecurityId)===String(instrument.securityId)&&market.spotExchangeSegment===instrument.exchangeSegment){underlyingPriceState[item.key]={...underlyingPriceState[item.key],spot: Number(price.toFixed(2)),updatedAt:new Date().toISOString()};}
    if(String(market.futureSecurityId)===String(instrument.securityId)&&instrument.exchangeSegment==='NSE_FNO'){underlyingPriceState[item.key]={...underlyingPriceState[item.key],future:Number(price.toFixed(2)),futureExpiry:market.futureExpiry,updatedAt:new Date().toISOString()};}
  }
}
const SECTOR_MAP = {
  NIFTY: 'Benchmark Index', BANKNIFTY: 'Banking Sector Index', FINNIFTY: 'Financials Index', MIDCPNIFTY: 'Midcap Index', NIFTYIT: 'IT Sector Index',
  HDFCBANK: 'Banking (Private)', ICICIBANK: 'Banking (Private)', SBIN: 'Banking (PSU)', AXISBANK: 'Banking (Private)', KOTAKBANK: 'Banking (Private)',
  INDUSINDBK: 'Banking (Private)', BANKBARODA: 'Banking (PSU)', PNB: 'Banking (PSU)', CANBK: 'Banking (PSU)', FEDERALBNK: 'Banking (Private)',
  AUBANK: 'Banking (Private)', BANDHANBNK: 'Banking (Private)', IDFCFIRSTB: 'Banking (Private)', INDIANB: 'Banking (PSU)', MAHABANK: 'Banking (PSU)',
  RBLBANK: 'Banking (Private)', UNIONBANK: 'Banking (PSU)', YESBANK: 'Banking (Private)', UJJIVANSFB: 'Banking (Small Finance)',
  BAJFINANCE: 'Financial Services', BAJAJFINSV: 'Financial Services', CHOLAFIN: 'Financial Services', SHRIRAMFIN: 'Financial Services',
  MUTHOOTFIN: 'Financial Services', JIOFIN: 'Financial Services', PFC: 'Financial Services (PSU)', RECLTD: 'Financial Services (PSU)',
  LICI: 'Insurance', HDFCLIFE: 'Insurance', SBILIFE: 'Insurance', ICICIPRULI: 'Insurance', ICICIGI: 'Insurance',
  HDFCAMC: 'Asset Management', NAM_INDIA: 'Asset Management', 'NAM-INDIA': 'Asset Management', '360ONE': 'Wealth Management',
  ABCAPITAL: 'Financial Services', ANANDRATHI: 'Financial Services', ANGELONE: 'Broking & Fintech', BSE: 'Capital Markets / Exchange',
  MCX: 'Commodity Exchange', CDSL: 'Depository Services', CAMS: 'Financial Infrastructure', KFINTECH: 'Financial Infrastructure',
  IEX: 'Energy Exchange', IREDA: 'Renewable Finance (PSU)', IRFC: 'Railway Finance (PSU)', LICHSGFIN: 'Housing Finance',
  PNBHOUSING: 'Housing Finance', MANAPPURAM: 'NBFC / Gold Loan', MFSL: 'Financial Services', MOTILALOFS: 'Broking & Wealth',
  PAYTM: 'Fintech / Digital', POLICYBZR: 'Fintech / Insurance', SBICARD: 'Credit Cards', BAJAJHLDNG: 'Holding Company', LTF: 'Financial Services',
  TCS: 'IT / Software', INFY: 'IT / Software', HCLTECH: 'IT / Software', WIPRO: 'IT / Software', TECHM: 'IT / Software',
  LTM: 'IT / Software', COFORGE: 'IT / Software', PERSISTENT: 'IT / Software', MPHASIS: 'IT / Software', OFSS: 'IT Products',
  KPITTECH: 'IT / Auto Tech', TATAELXSI: 'IT / Design Tech', NAUKRI: 'Internet / Classifieds', SAGILITY: 'Healthcare IT / BPM',
  MARUTI: 'Automobiles', 'M&M': 'Automobiles', 'BAJAJ-AUTO': 'Automobiles (2/3W)', HEROMOTOCO: 'Automobiles (2W)',
  EICHERMOT: 'Automobiles (2W/CV)', TVSMOTOR: 'Automobiles (2W)', ASHOKLEY: 'Commercial Vehicles', HYUNDAI: 'Automobiles',
  FORCEMOT: 'Automobiles', BHARATFORG: 'Auto Ancillaries', BOSCHLTD: 'Auto Ancillaries', MOTHERSON: 'Auto Components',
  SONACOMS: 'Auto Ancillaries', TIINDIA: 'Auto & Cycles', TMPV: 'Auto Components', UNOMINDA: 'Auto Components', ATHERENERG: 'EV / Automobiles',
  RELIANCE: 'Oil, Gas & Energy', ONGC: 'Oil & Gas Exploration', OIL: 'Oil & Gas Exploration', BPCL: 'Refining & Marketing',
  IOC: 'Refining & Marketing', HINDPETRO: 'Refining & Marketing', GAIL: 'Natural Gas Transmission', PETRONET: 'LNG Terminal / Gas',
  NTPC: 'Power Generation (PSU)', POWERGRID: 'Power Transmission (PSU)', TATAPOWER: 'Power & Green Energy', ADANIENSOL: 'Power Transmission',
  ADANIGREEN: 'Renewable Energy', ADANIPOWER: 'Thermal Power', JSWENERGY: 'Power Generation', NHPC: 'Hydroelectric Power',
  INOXWIND: 'Wind Energy', SUZLON: 'Wind Energy', PREMIERENE: 'Solar Energy', WAAREEENER: 'Solar Energy Equipment',
  TATASTEEL: 'Steel & Metals', JSWSTEEL: 'Steel & Metals', JINDALSTEL: 'Steel & Metals', SAIL: 'Steel (PSU)',
  HINDALCO: 'Aluminum & Copper', VEDL: 'Diversified Metals', NATIONALUM: 'Aluminum (PSU)', HINDZINC: 'Zinc & Lead',
  COALINDIA: 'Coal Mining (PSU)', NMDC: 'Iron Ore Mining (PSU)',
  SUNPHARMA: 'Pharmaceuticals', DRREDDY: 'Pharmaceuticals', CIPLA: 'Pharmaceuticals', DIVISLAB: 'Pharma / API',
  LUPIN: 'Pharmaceuticals', AUROPHARMA: 'Pharmaceuticals', ZYDUSLIFE: 'Pharmaceuticals', BIOCON: 'Biopharmaceuticals',
  MANKIND: 'Pharmaceuticals', LAURUSLABS: 'Pharma / API', GLENMARK: 'Pharmaceuticals', APOLLOHOSP: 'Hospitals & Healthcare',
  FORTIS: 'Hospitals & Healthcare', MAXHEALTH: 'Hospitals & Healthcare',
  ITC: 'Diversified FMCG & Tobacco', HINDUNILVR: 'FMCG / Personal Care', NESTLEIND: 'FMCG / Packaged Food', BRITANNIA: 'FMCG / Foods',
  TATACONSUM: 'FMCG / Beverages & Food', MARICO: 'FMCG / Consumer', DABUR: 'FMCG / Ayurvedic', COLPAL: 'FMCG / Oral Care',
  GODREJCP: 'FMCG / Household', VBL: 'Beverages & Bottling', UNITDSPR: 'Alcoholic Beverages', RADICO: 'Alcoholic Beverages',
  GODFRYPHLP: 'Tobacco & Cigarettes', PATANJALI: 'FMCG & Foods', JUBLFOOD: 'QSR & Food Service', DMART: 'Retail / Hypermarkets',
  TRENT: 'Retail / Fashion', TITAN: 'Consumer Lifestyle & Jewelry', PAGEIND: 'Apparel & Innerwear', NYKAA: 'Beauty & Fashion E-Commerce',
  SWIGGY: 'Quick Commerce & Food',
  LT: 'Infrastructure & Engineering', SIEMENS: 'Industrial Engineering', ABB: 'Power & Automation Tech', BEL: 'Defense Electronics (PSU)',
  HAL: 'Aerospace & Defense (PSU)', BDL: 'Defense Systems (PSU)', BHEL: 'Heavy Electricals (PSU)', MAZDOCK: 'Defense Shipbuilding (PSU)',
  COCHINSHIP: 'Shipbuilding (PSU)', CUMMINSIND: 'Engines & Heavy Equipment', POLYCAB: 'Wires & Electricals', KEI: 'Wires & Cables',
  HAVELLS: 'Consumer Electricals', CGPOWER: 'Industrial Electricals', APLAPOLLO: 'Structural Steel Pipes', GVT_D: 'Power Equipment',
  'GVT&D': 'Power Transmission Tech', POWERINDIA: 'Power Engineering', KAYNES: 'Electronics Manufacturing', RVNL: 'Rail Infrastructure (PSU)',
  SOLARINDS: 'Industrial Explosives',
  ULTRACEMCO: 'Cement', GRASIM: 'Cement & Chemicals', AMBUJACEM: 'Cement', SHREECEM: 'Cement', ASTRAL: 'Pipes & Building Materials',
  SUPREMEIND: 'Plastic Products & Pipes', PIDILITIND: 'Adhesives & Chemicals', ASIANPAINT: 'Paints & Decor',
  DLF: 'Real Estate', GODREJPROP: 'Real Estate', OBEROIRLTY: 'Real Estate', PRESTIGE: 'Real Estate', LODHA: 'Real Estate', PHOENIXLTD: 'Real Estate / Malls',
  ADANIPORTS: 'Ports & Logistics', ADANIENT: 'Diversified Incubator', CONCOR: 'Container Logistics (PSU)', DELHIVERY: 'Logistics & Supply Chain',
  GMRAIRPORT: 'Airport Infrastructure', NBCC: 'Construction (PSU)',
  BHARTIARTL: 'Telecom Services', IDEA: 'Telecom Services', INDUSTOWER: 'Telecom Towers',
  VOLTAS: 'Air Conditioning & Cooling', BLUESTARCO: 'Cooling Products', CROMPTON: 'Consumer Electricals', DIXON: 'Electronics Manufacturing',
  PGEL: 'Consumer Electronics EMS', KALYANKJIL: 'Jewelry Retail',
  SRF: 'Specialty Chemicals', PIIND: 'Agro-Chemicals', UPL: 'Crop Protection Chemicals',
  INDIGO: 'Aviation / Airlines', INDHOTEL: 'Hotels & Hospitality',
  AMBER: 'HVAC Components', ENRIN: 'Energy Solutions', ETERNAL: 'Engineering & Tech', VMM: 'Packaging & Manufacturing'
};

function getSector(underlying, kind) {
  if (SECTOR_MAP[underlying]) return SECTOR_MAP[underlying];
  if (kind === 'Index') return 'Index / Sector';
  return 'Equity / F&O';
}

function contractState(c) {
  const saved = state.contracts[c.symbol] || {};
  const straddleVal = saved.straddle ?? ((Number(c.ce.lastPrice)>0&&Number(c.pe.lastPrice)>0)?Number((Number(c.ce.lastPrice)+Number(c.pe.lastPrice)).toFixed(2)):null);
  let ceMacd = saved.ceMacd ?? null;
  let peMacd = saved.peMacd ?? null;
  let ceMacdFastEma = saved.ceMacdFastEma ?? null;
  let ceMacdSlowEma = saved.ceMacdSlowEma ?? null;
  let peMacdFastEma = saved.peMacdFastEma ?? null;
  let peMacdSlowEma = saved.peMacdSlowEma ?? null;

  if (ceMacd === null && saved.macd !== null && straddleVal > 0) {
    const cePrice = Number(saved.ceLtp ?? c.ce?.lastPrice ?? 0);
    const ratio = Math.max(0.02, Math.min(0.98, cePrice > 0 ? cePrice / Number(straddleVal) : 0.5));
    ceMacd = Number((saved.macd * ratio).toFixed(4));
    peMacd = Number((saved.macd * (1 - ratio)).toFixed(4));
    if (saved.macdFastEma !== null) {
      ceMacdFastEma = Number((saved.macdFastEma * ratio).toFixed(2));
      ceMacdSlowEma = Number((saved.macdSlowEma * ratio).toFixed(2));
      peMacdFastEma = Number((saved.macdFastEma * (1 - ratio)).toFixed(2));
      peMacdSlowEma = Number((saved.macdSlowEma * (1 - ratio)).toFixed(2));
    }
  }

  return { symbol: c.symbol, underlying: c.underlying || c.symbol, kind: c.kind || 'F&O', expiry: c.expiry,
    sector: getSector(c.underlying || c.symbol, c.kind),
    isStrangle: isStrangle(c),
    pairType: isStrangle(c) ? 'Strangle' : 'Straddle',
    timeframe: timeframeFor(c),
    watchlistTab: c.watchlistTab || 1,
    customName: c.customName || (c.ce.strike === c.pe.strike ? `${c.underlying || c.symbol} ${c.ce.strike}` : `${c.underlying || c.symbol} ${c.ce.strike}C/${c.pe.strike}P`),
    ceStrike: c.ce.strike ?? null, peStrike: c.pe.strike ?? null, ceOiAtSelection: c.ce.oiAtSelection ?? null, peOiAtSelection: c.pe.oiAtSelection ?? null,
    ceLtp: saved.ceLtp ?? c.ce.lastPrice ?? null, peLtp: saved.peLtp ?? c.pe.lastPrice ?? null,
    straddle: straddleVal,
    change: saved.change ?? null,
    changePct: saved.changePct ?? null,
    macd: saved.macd ?? null,
    macdFastEma: saved.macdFastEma ?? null,
    macdSlowEma: saved.macdSlowEma ?? null,
    ceMacd,
    ceMacdFastEma,
    ceMacdSlowEma,
    peMacd,
    peMacdFastEma,
    peMacdSlowEma,
    ema: saved.ema ?? null, alert: saved.alert || 0, lastUpdated: saved.lastUpdated || null,
    indicatorBars: saved.indicatorBars ?? 0, macdBarsRequired: saved.macdBarsRequired ?? (settings.macdSlow || 26),
    emaBarsRequired: saved.emaBarsRequired ?? settings.emaPeriod, macdReady: saved.macdReady ?? false, emaReady: saved.emaReady ?? false,
    indicatorError: saved.indicatorError || null,
    status: saved.status || 'warming-up' };
}
function ema(values, period) {
  if (values.length < period) return null;
  const alpha = 2 / (period + 1);
  let current = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (const v of values.slice(period)) current = v * alpha + current * (1 - alpha);
  return current;
}
function macd(values, fast = 12, slow = 26) {
  if (!values || values.length < slow) return null;
  const fastEma = ema(values, fast);
  const slowEma = ema(values, slow);
  if (fastEma === null || slowEma === null) return null;
  // MACD line = 12-Period EMA − 26-Period EMA
  return fastEma - slowEma;
}
async function sendTelegramMessage(botToken, chatId, text) {
  if (!botToken || !chatId || !text) return { ok: false, description: 'Missing bot token or chat ID' };
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      }),
      signal: AbortSignal.timeout(6000)
    });
    return await response.json();
  } catch (error) {
    return { ok: false, description: error.message };
  }
}

let telegramQueue = Promise.resolve();
function queueTelegramAlert(botToken, chatId, text) {
  telegramQueue = telegramQueue.then(async () => {
    const res = await sendTelegramMessage(botToken, chatId, text);
    if (!res.ok) console.warn('Telegram warning:', res.description || 'failed');
    await new Promise(r => setTimeout(r, 100));
  }).catch(err => {
    console.error('Telegram queue error:', err.message);
  });
  return telegramQueue;
}

const lastAlertState = new Map();

async function checkAndSendTelegramAlert(c, alertLevel, straddleData) {
  if (!settings.telegramEnabled) return;
  const botToken = String(settings.telegramBotToken || '').trim();
  const chatId = String(settings.telegramChatId || '').trim();
  if (!botToken || !chatId) return;

  const key = c.symbol;
  const prevAlert = lastAlertState.get(key) || 0;
  lastAlertState.set(key, alertLevel);

  if (alertLevel <= 0) return;
  if (alertLevel === prevAlert) return;
  if (alertLevel === 3 && !settings.telegramAlertThree) return;
  if (alertLevel === 5 && !settings.telegramAlertFive) return;

  const underlying = c.underlying || c.symbol;
  const sector = getSector(underlying, c.kind);
  const tf = timeframeFor(c);
  const tfStr = tf === 1440 ? '1 Day' : tf >= 60 ? `${tf / 60} Hour` : `${tf} Min`;
  const isFiveStar = alertLevel === 5;
  const strangle = isStrangle(c);
  const pairType = strangle ? 'Strangle' : 'Straddle';
  const pairTypeUpper = strangle ? 'STRANGLE' : 'STRADDLE';
  const header = isFiveStar ? `🌟🌟🌟🌟🌟 <b>5-STAR ${pairTypeUpper} ALERT</b>` : `⭐⭐⭐ <b>3-STAR ${pairTypeUpper} ALERT</b>`;
  const condition = isFiveStar ? `MACD ≥ 0 AND ${pairType} &gt; 200 EMA` : 'MACD (12 − 26 EMA) ≥ 0';
  const nowStr = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(new Date());

  const diffEma = straddleData.ema != null ? (Number(straddleData.straddle) - Number(straddleData.ema)).toFixed(2) : null;
  const emaDiffText = isFiveStar && diffEma != null ? `\n  • ${pairType} is <b>₹${diffEma} above 200 EMA</b>` : '';

  const msg = `${header}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<b>Instrument:</b> #${underlying} (${c.kind || 'F&O'})\n` +
    `<b>Strategy:</b> ${pairType} (${tfStr})\n` +
    `<b>Sector:</b> ${sector}\n` +
    `<b>Expiry:</b> ${c.expiry || '—'}\n\n` +
    `<b>Call Strike:</b> ${c.ce?.strike ?? '—'} CE @ ₹${Number(straddleData.ceLtp ?? 0).toFixed(2)}\n` +
    `<b>Put Strike:</b> ${c.pe?.strike ?? '—'} PE @ ₹${Number(straddleData.peLtp ?? 0).toFixed(2)}\n` +
    `<b>${pairType} LTP:</b> <b>₹${Number(straddleData.straddle ?? 0).toFixed(2)}</b>\n\n` +
    `<b>📊 Indicators (${tfStr}):</b>\n` +
    `• <b>MACD (12, 26):</b> ${Number(straddleData.macd || 0) >= 0 ? '+' : ''}${Number(straddleData.macd || 0).toFixed(4)}\n` +
    `  (12 EMA: ${straddleData.macdFastEma != null ? Number(straddleData.macdFastEma).toFixed(2) : '—'} | 26 EMA: ${straddleData.macdSlowEma != null ? Number(straddleData.macdSlowEma).toFixed(2) : '—'})\n` +
    `• <b>200 EMA:</b> ₹${straddleData.ema != null ? Number(straddleData.ema).toFixed(2) : '—'}${emaDiffText}\n\n` +
    `<b>Rule:</b> ${condition}\n` +
    `<b>Time:</b> ${nowStr} IST\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<i>Straddle & Strangle Signal Scanner</i>`;

  queueTelegramAlert(botToken, chatId, msg);
  console.log(`Telegram alert queued for ${underlying} (${alertLevel}-star)`);
}

function indiaDateTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const get = t => parts.find(p => p.type === t)?.value || '00';
  const year = get('year'), month = get('month'), day = get('day');
  const hour = get('hour'), minute = get('minute'), second = get('second');
  return {
    year, month, day,
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}:${second}`,
    dateTimeStr: `${year}-${month}-${day} ${hour}:${minute}:${second}`
  };
}

const lastLoggedAlert = new Map();

function initLastLoggedAlerts() {
  const todayKey = indiaDateTime().date;
  for (const a of alertsHistory) {
    if (a.date === todayKey) {
      lastLoggedAlert.set(a.symbol, {
        alertLevel: a.alertLevel,
        barTime: a.barTime,
        date: a.date,
        time: a.time
      });
    }
  }
}
initLastLoggedAlerts();

function logAlertEvent(c, alertLevel, straddleData, triggerType = 'Live Trigger', barTimeEpoch = null) {
  if (alertLevel <= 0) return;
  const key = c.symbol;
  const now = indiaDateTime();
  const todayKey = now.date;

  const barTimeStr = barTimeEpoch ? indiaDateTime(new Date(barTimeEpoch)).time : now.time;
  const prev = lastLoggedAlert.get(key);

  const isLevelChange = !prev || prev.alertLevel !== alertLevel;
  const isNewBar = prev && barTimeEpoch && prev.barTime !== barTimeStr;

  if (!isLevelChange && !isNewBar) return;

  const underlying = c.underlying || c.symbol;
  const sector = getSector(underlying, c.kind);
  const tf = timeframeFor(c);
  const tfStr = tf === 1440 ? '1 Day' : tf >= 60 ? `${tf / 60} Hour` : `${tf} Min`;
  const strangle = isStrangle(c);
  const pairType = strangle ? 'Strangle' : 'Straddle';

  let eventType = triggerType;
  if (isLevelChange) {
    if (!prev || prev.alertLevel === 0) eventType = 'Initial Trigger';
    else if (alertLevel > prev.alertLevel) eventType = 'Upgrade (3★→5★)';
    else eventType = 'Downgrade (5★→3★)';
  } else if (isNewBar) {
    eventType = 'Candle Close Update';
  }

  const emaVal = straddleData.ema != null ? Number(Number(straddleData.ema).toFixed(2)) : null;
  const straddleVal = straddleData.straddle != null ? Number(Number(straddleData.straddle).toFixed(2)) : null;
  const emaDiff = (straddleVal != null && emaVal != null) ? Number((straddleVal - emaVal).toFixed(2)) : null;
  const emaDiffPct = (straddleVal != null && emaVal != null && emaVal > 0)
    ? Number((((straddleVal - emaVal) / emaVal) * 100).toFixed(2))
    : null;

  const entry = {
    id: `ALT-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    timestamp: new Date().toISOString(),
    date: todayKey,
    time: now.time,
    barTime: barTimeStr,
    alertLevel,
    alertType: alertLevel === 5 ? '5-Star' : '3-Star',
    eventType,
    symbol: key,
    underlying,
    kind: c.kind || 'F&O',
    pairType,
    sector,
    expiry: c.expiry || '—',
    timeframe: tfStr,
    ceStrike: c.ce?.strike ?? null,
    ceLtp: straddleData.ceLtp != null ? Number(Number(straddleData.ceLtp).toFixed(2)) : null,
    peStrike: c.pe?.strike ?? null,
    peLtp: straddleData.peLtp != null ? Number(Number(straddleData.peLtp).toFixed(2)) : null,
    straddleLtp: straddleVal,
    straddleEma200: emaVal,
    emaDifference: emaDiff,
    emaDiffPct,
    macdValue: straddleData.macd != null ? Number(Number(straddleData.macd).toFixed(4)) : null,
    macdFastEma: straddleData.macdFastEma != null ? Number(Number(straddleData.macdFastEma).toFixed(2)) : null,
    macdSlowEma: straddleData.macdSlowEma != null ? Number(Number(straddleData.macdSlowEma).toFixed(2)) : null,
    ceMacd: straddleData.ceMacd != null ? Number(Number(straddleData.ceMacd).toFixed(4)) : null,
    peMacd: straddleData.peMacd != null ? Number(Number(straddleData.peMacd).toFixed(4)) : null,
    ceOi: c.ce?.oiAtSelection ?? null,
    peOi: c.pe?.oiAtSelection ?? null,
    rule: alertLevel === 5 ? `MACD ≥ 0 AND ${pairType} > 200 EMA` : 'MACD (12 − 26 EMA) ≥ 0',
    indicatorBars: straddleData.indicatorBars || 0,
    status: straddleData.status || 'live'
  };

  alertsHistory.push(entry);
  lastLoggedAlert.set(key, {
    alertLevel,
    barTime: barTimeStr,
    date: todayKey,
    time: now.time
  });
  saveAlertsDebounced();
  console.log(`[Alert Logged] ${underlying} ${entry.alertType} (${eventType}) @ ₹${straddleVal} [${now.time} IST]`);
}

function generateDailyExcelWorkbook(targetDate) {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  alertsHistory = loadJson(ALERTS_HISTORY_FILE, alertsHistory);
  const dayAlerts = alertsHistory.filter(a => a.date === targetDate);

  // Sheet 1: Triggered Alerts
  const alertsSheetData = dayAlerts.map(a => ({
    'Date': a.date,
    'Time (IST)': a.time,
    'Candle Bar Time': a.barTime || a.time,
    'Alert Level': a.alertType,
    'Event Type': a.eventType || 'Trigger',
    'Underlying': a.underlying,
    'Instrument Kind': a.kind,
    'Strategy / Type': a.pairType || ((a.ceStrike != null && a.peStrike != null && a.ceStrike !== a.peStrike) ? 'Strangle' : 'Straddle'),
    'Sector': a.sector,
    'Expiry': a.expiry,
    'Timeframe': a.timeframe,
    'Combined LTP (₹)': a.straddleLtp,
    '200 EMA (₹)': a.straddleEma200,
    'Diff from EMA (₹)': a.emaDifference,
    '% Diff from EMA': a.emaDiffPct != null ? `${a.emaDiffPct}%` : '—',
    'MACD (12, 26)': a.macdValue,
    'MACD Fast EMA (12)': a.macdFastEma,
    'MACD Slow EMA (26)': a.macdSlowEma,
    'Call Strike': a.ceStrike,
    'Call LTP (₹)': a.ceLtp,
    'Put Strike': a.peStrike,
    'Put LTP (₹)': a.peLtp,
    'Call MACD': a.ceMacd,
    'Put MACD': a.peMacd,
    'Call OI': a.ceOi,
    'Put OI': a.peOi,
    'Trigger Condition': a.rule,
    'Total Bars': a.indicatorBars || 0,
    'Feed Status': a.status
  }));

  // Sheet 2: Watchlist Snapshot
  const contractsSnapshot = config.contracts.map(c => {
    const s = state.contracts[c.symbol] || {};
    const alertLabel = s.alert === 5 ? '5-Star' : s.alert === 3 ? '3-Star' : 'None';
    const emaDiff = (s.straddle != null && s.ema != null) ? Number((Number(s.straddle) - Number(s.ema)).toFixed(2)) : null;
    const tf = timeframeFor(c);
    const tfStr = tf === 1440 ? '1 Day' : tf >= 60 ? `${tf / 60} Hour` : `${tf} Min`;
    const strangle = isStrangle(c);
    const pairType = strangle ? 'Strangle' : 'Straddle';
    return {
      'Underlying': c.underlying || c.symbol,
      'Kind': c.kind || 'F&O',
      'Strategy / Type': pairType,
      'Sector': getSector(c.underlying || c.symbol, c.kind),
      'Expiry': c.expiry || '—',
      'Timeframe': tfStr,
      'Call Strike': c.ce?.strike ?? '—',
      'Call LTP (₹)': s.ceLtp ?? '—',
      'Put Strike': c.pe?.strike ?? '—',
      'Put LTP (₹)': s.peLtp ?? '—',
      'Combined LTP (₹)': s.straddle ?? '—',
      '200 EMA (₹)': s.ema ?? '—',
      'Diff from EMA (₹)': emaDiff ?? '—',
      'MACD (12, 26)': s.macd ?? '—',
      '12 Fast EMA': s.macdFastEma ?? '—',
      '26 Slow EMA': s.macdSlowEma ?? '—',
      'Call MACD': s.ceMacd ?? '—',
      'Put MACD': s.peMacd ?? '—',
      'Closing Alert': alertLabel,
      'Indicator Bars': s.indicatorBars ?? 0,
      'Status': s.status ?? 'warming-up'
    };
  });

  // Sheet 3: Stock 200 EMA Scan
  const stockEmaData = stockEmaRows().map(r => ({
    'Symbol': r.symbol,
    'Weekly Close (₹)': r.weeklyClose,
    '200 EMA (₹)': r.ema200,
    'Distance %': `${r.distancePct}%`,
    'Status': r.status,
    'As Of': r.asOf || '—',
    'Updated At': r.updatedAt
  }));

  const wb = XLSX.utils.book_new();

  // Create wsAlerts
  const wsAlerts = XLSX.utils.json_to_sheet(alertsSheetData.length > 0 ? alertsSheetData : [
    { 'Notice': `No alerts were recorded on ${targetDate}.` }
  ]);
  wsAlerts['!cols'] = [
    { wch: 12 }, { wch: 12 }, { wch: 16 }, { wch: 12 }, { wch: 20 },
    { wch: 15 }, { wch: 15 }, { wch: 20 }, { wch: 12 }, { wch: 12 },
    { wch: 20 }, { wch: 14 }, { wch: 18 }, { wch: 16 }, { wch: 14 },
    { wch: 18 }, { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
    { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
    { wch: 34 }, { wch: 12 }, { wch: 12 }
  ];
  XLSX.utils.book_append_sheet(wb, wsAlerts, "Triggered Alerts");

  // Create wsSnapshot
  const wsSnapshot = XLSX.utils.json_to_sheet(contractsSnapshot);
  wsSnapshot['!cols'] = [
    { wch: 15 }, { wch: 10 }, { wch: 20 }, { wch: 12 }, { wch: 10 },
    { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 20 },
    { wch: 14 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 14 },
    { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 12 }
  ];
  XLSX.utils.book_append_sheet(wb, wsSnapshot, "EOD Watchlist Snapshot");

  // Create wsStock if data exists
  if (stockEmaData.length > 0) {
    const wsStock = XLSX.utils.json_to_sheet(stockEmaData);
    wsStock['!cols'] = [{ wch: 15 }, { wch: 15 }, { wch: 15 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 24 }];
    XLSX.utils.book_append_sheet(wb, wsStock, "Stock 200 EMA Scan");
  }

  const baseFileName = `Fixed_Straddle_Alerts_${targetDate}`;
  const xlsxPath = path.join(REPORTS_DIR, `${baseFileName}.xlsx`);
  const csvPath = path.join(REPORTS_DIR, `${baseFileName}.csv`);

  XLSX.writeFile(wb, xlsxPath);

  // Write CSV for Sheet 1
  const csvContent = alertsSheetData.length > 0
    ? XLSX.utils.sheet_to_csv(wsAlerts)
    : `Notice\nNo alerts were recorded on ${targetDate}.\n`;
  fs.writeFileSync(csvPath, csvContent, 'utf8');

  return {
    date: targetDate,
    fileName: `${baseFileName}.xlsx`,
    csvFileName: `${baseFileName}.csv`,
    xlsxPath,
    csvPath,
    alertCount: dayAlerts.length,
    fiveStarCount: dayAlerts.filter(a => a.alertLevel === 5).length,
    threeStarCount: dayAlerts.filter(a => a.alertLevel === 3).length
  };
}

function getAvailableReportDates() {
  if (!fs.existsSync(REPORTS_DIR)) return [];
  const files = fs.readdirSync(REPORTS_DIR);
  const reports = [];
  for (const f of files) {
    if (f.startsWith('Fixed_Straddle_Alerts_') && f.endsWith('.xlsx')) {
      const datePart = f.replace('Fixed_Straddle_Alerts_', '').replace('.xlsx', '');
      const stat = fs.statSync(path.join(REPORTS_DIR, f));
      const alertCount = alertsHistory.filter(a => a.date === datePart).length;
      reports.push({
        date: datePart,
        fileName: f,
        csvFileName: `Fixed_Straddle_Alerts_${datePart}.csv`,
        sizeBytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
        alertCount
      });
    }
  }
  return reports.sort((a, b) => b.date.localeCompare(a.date));
}

async function sendTelegramDocument(botToken, chatId, filePath, caption) {
  try {
    const fileName = path.basename(filePath);
    const fileBytes = fs.readFileSync(filePath);
    const form = new FormData();
    form.append('chat_id', chatId);
    if (caption) form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    form.append('document', new Blob([fileBytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), fileName);

    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
      method: 'POST',
      body: form
    });
    const result = await response.json();
    return result;
  } catch (err) {
    console.error('sendTelegramDocument error:', err.message);
    return { ok: false, description: err.message };
  }
}

async function sendEodTelegramReport(targetDate, report) {
  if (!settings.telegramEnabled) return;
  const botToken = String(settings.telegramBotToken || '').trim();
  const chatId = String(settings.telegramChatId || '').trim();
  if (!botToken || !chatId) return;

  const caption = `📊 <b>END-OF-DAY STRADDLE ALERT REPORT</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📅 <b>Date:</b> ${targetDate} (IST)\n` +
    `⭐ <b>Total Alerts:</b> ${report.alertCount}\n` +
    `  • <b>5-Star Alerts:</b> ${report.fiveStarCount}\n` +
    `  • <b>3-Star Alerts:</b> ${report.threeStarCount}\n\n` +
    `📁 <i>Excel backtest file (.xlsx) attached below:</i>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<i>Fixed Straddle Scanner</i>`;

  console.log(`Sending EOD Excel report for ${targetDate} to Telegram...`);
  const docRes = await sendTelegramDocument(botToken, chatId, report.xlsxPath, caption);
  if (!docRes.ok) {
    console.warn('sendTelegramDocument failed, falling back to text message:', docRes.description);
    await sendTelegramMessage(botToken, chatId, caption);
  } else {
    console.log(`EOD Excel document sent to Telegram for ${targetDate}`);
  }
}

function evaluate(c, isLive = false) {
  const key = c.symbol;
  const bars = candles.get(key);
  // Indicators and alerts use only completed close-price points.
  const validBars = (bars || []).filter(b => b.closed && Number.isFinite(b.close) && b.close > 0 && Number.isFinite(b.ce) && b.ce > 0 && Number.isFinite(b.pe) && b.pe > 0);
  if (!validBars.length) return;
  const closes = validBars.map(b => b.close);
  const fastPeriod = Number(settings.macdFast) || 12;
  const slowPeriod = Number(settings.macdSlow) || 26;
  const macdBarsRequired = slowPeriod;
  const fastEma = ema(closes, fastPeriod);
  const slowEma = ema(closes, slowPeriod);
  const m = (fastEma !== null && slowEma !== null) ? fastEma - slowEma : null;
  const e = ema(closes, settings.emaPeriod);
  const macdReady = m !== null, emaReady = e !== null;
  const latest = validBars.at(-1);
  const alert = macdReady && m >= 0 ? (emaReady && latest.close > e ? 5 : 3) : 0;

  // Individual CE and PE leg indicators
  const ceCloses = validBars.map(b => b.ce);
  const ceFastEma = ema(ceCloses, fastPeriod);
  const ceSlowEma = ema(ceCloses, slowPeriod);
  const ceM = (ceFastEma !== null && ceSlowEma !== null) ? Number((ceFastEma - ceSlowEma).toFixed(4)) : null;

  const peCloses = validBars.map(b => b.pe);
  const peFastEma = ema(peCloses, fastPeriod);
  const peSlowEma = ema(peCloses, slowPeriod);
  const peM = (peFastEma !== null && peSlowEma !== null) ? Number((peFastEma - peSlowEma).toFixed(4)) : null;

  state.contracts[key] = { ...state.contracts[key], symbol: key, kind: c.kind || 'F&O', expiry: c.expiry,
    underlying: c.underlying || c.symbol, ceStrike: c.ce.strike ?? null, peStrike: c.pe.strike ?? null,
    ceOiAtSelection: c.ce.oiAtSelection ?? null, peOiAtSelection: c.pe.oiAtSelection ?? null,
    ceLtp:state.contracts[key]?.ceLtp ?? c.ce.lastPrice ?? null, peLtp:state.contracts[key]?.peLtp ?? c.pe.lastPrice ?? null,
    straddle: Number((((Number(state.contracts[key]?.ceLtp) || latest.ce) + (Number(state.contracts[key]?.peLtp) || latest.pe))).toFixed(2)),
    macd: m === null ? null : Number(m.toFixed(4)),
    macdFastEma: fastEma === null ? null : Number(fastEma.toFixed(2)),
    macdSlowEma: slowEma === null ? null : Number(slowEma.toFixed(2)),
    ceMacd: ceM,
    ceMacdFastEma: ceFastEma === null ? null : Number(ceFastEma.toFixed(2)),
    ceMacdSlowEma: ceSlowEma === null ? null : Number(ceSlowEma.toFixed(2)),
    peMacd: peM,
    peMacdFastEma: peFastEma === null ? null : Number(peFastEma.toFixed(2)),
    peMacdSlowEma: peSlowEma === null ? null : Number(peSlowEma.toFixed(2)),
    ema: e === null ? null : Number(e.toFixed(2)), alert,
    indicatorBars: validBars.length, macdBarsRequired, emaBarsRequired: settings.emaPeriod, macdReady, emaReady,
    indicatorError: state.contracts[key]?.indicatorError || null,
    lastUpdated: new Date().toISOString(), status: emaReady ? 'live' : 'warming-up' };
  state.updatedAt = new Date().toISOString();
  saveStateDebounced();
  if (alert > 0) {
    const latestBar = validBars.at(-1);
    logAlertEvent(c, alert, state.contracts[key], isLive ? 'Live Trigger' : 'Warmup Snapshot', latestBar?.time);
  }
  if (isLive && alert > 0) {
    void checkAndSendTelegramAlert(c, alert, state.contracts[key]);
  } else if (isLive && alert === 0) {
    lastAlertState.set(key, 0);
  }
}
function updateLeg(instrument, price, epochSeconds) {
  if (!Number.isFinite(price) || price <= 0) return;
  const time = Number(epochSeconds) > 0 ? Number(epochSeconds) * 1000 : Date.now();
  for (const c of config.contracts) {
    const isCe = String(c.ce?.securityId) === String(instrument.securityId) && c.ce?.exchangeSegment === instrument.exchangeSegment;
    const isPe = String(c.pe?.securityId) === String(instrument.securityId) && c.pe?.exchangeSegment === instrument.exchangeSegment;
    if (!isCe && !isPe) continue;
    const timeframe=timeframeFor(c);
    const bucket = candleBucketStart(time, timeframe);
    const sessionDay = new Date(time + TZ_OFFSET_MS).toISOString().slice(0, 10);
    const map = candles.get(c.symbol) || [];
    let bar = map.find(item => item.time === bucket);
    if (!bar) {
      const ceMark = legMarks.get(`${c.symbol}:ce`);
      const peMark = legMarks.get(`${c.symbol}:pe`);
      bar = { time: bucket,
        ce: ceMark?.day === sessionDay ? ceMark.price : null,
        pe: peMark?.day === sessionDay ? peMark.price : null,
        close: 0, closed: false };
      if (bar.ce > 0 && bar.pe > 0) bar.close = bar.ce + bar.pe;
      map.push(bar);
      map.sort((a,b) => a.time - b.time);
      if (map.length > Math.max(600, settings.emaPeriod * 3)) map.splice(0, map.length - Math.max(600, settings.emaPeriod * 3));
      candles.set(c.symbol, map);
    }
    bar[isCe ? 'ce' : 'pe'] = price;
    legMarks.set(`${c.symbol}:${isCe ? 'ce' : 'pe'}`, { price, day: sessionDay });
    const prior = state.contracts[c.symbol] || {};
    state.contracts[c.symbol] = { ...prior, symbol:c.symbol, underlying:c.underlying || c.symbol,
      ceLtp:isCe ? Number(price.toFixed(2)) : prior.ceLtp ?? c.ce.lastPrice ?? null,
      peLtp:isPe ? Number(price.toFixed(2)) : prior.peLtp ?? c.pe.lastPrice ?? null };
    if (bar.ce !== null && bar.pe !== null) {
      bar.close = bar.ce + bar.pe;
      if (typeof bar.open !== 'number' || bar.open <= 0) bar.open = bar.close;
      bar.high = Math.max(bar.high || bar.close, bar.close);
      bar.low = Math.min(bar.low || bar.close, bar.close);
      const dayStart = (candles.get(c.symbol) || [])[0]?.close || bar.close;
      const change = Number((bar.close - dayStart).toFixed(2));
      const changePct = dayStart > 0 ? Number(((change / dayStart) * 100).toFixed(2)) : 0;
      state.contracts[c.symbol] = { ...prior, symbol: c.symbol, kind: c.kind || 'F&O', expiry: c.expiry,
        underlying: c.underlying || c.symbol,
        ceStrike: c.ce.strike ?? null, peStrike: c.pe.strike ?? null, ceOiAtSelection: c.ce.oiAtSelection ?? null, peOiAtSelection: c.pe.oiAtSelection ?? null,
        ceLtp:Number(bar.ce.toFixed(2)), peLtp:Number(bar.pe.toFixed(2)),
        straddle: Number(bar.close.toFixed(2)), change, changePct, lastUpdated: new Date().toISOString(), status: 'live' };
      state.updatedAt = new Date().toISOString();
    }
    finalizeClosedBars();
  }
}

function barCloseTime(bar, timeframe) {
  const localStart = bar.time + TZ_OFFSET_MS;
  const local = new Date(localStart);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const sessionClose = midnight + (15 * 60 + 30) * 60_000;
  if (timeframe === 1440) return sessionClose - TZ_OFFSET_MS;
  return Math.min(bar.time + timeframe * 60_000, sessionClose - TZ_OFFSET_MS);
}
function finalizeClosedBars(now = Date.now()) {
  for (const contract of config.contracts) {
    if (!validContract(contract)) continue;
    const timeframe = timeframeFor(contract), bars = candles.get(contract.symbol) || [];
    let changed = false;
    for (const bar of bars) {
      if (!bar.closed && now >= barCloseTime(bar, timeframe)) { bar.closed = true; changed = true; }
    }
    if (changed) evaluate(contract, true);
  }
}

function historyInterval(timeframe) {
  if (timeframe <= 3) return 1;
  if (timeframe <= 5) return 5;
  if (timeframe <= 15) return 15;
  if (timeframe <= 30) return 15;
  return 60;
}
async function fetchCandles(instrument, fromDate, toDate, interval) {
  const daily=interval==='day';
  const response=await apiFetch(`https://api.dhan.co/v2/charts/${daily?'historical':'intraday'}`,{method:'POST',headers:{
    'Content-Type':'application/json',Accept:'application/json','access-token':dhanCredentials.accessToken
  },body:JSON.stringify({securityId:String(instrument.securityId),exchangeSegment:instrument.exchangeSegment,
    instrument:instrument.instrument,...(daily?{}:{interval:String(interval)}),oi:false,fromDate,toDate})});
  let data={};try{data=await response.json()}catch{}
  if(!response.ok)throw new Error(`Dhan candle history HTTP ${response.status}${data.errorCode?` ${data.errorCode}`:''}${data.errorMessage?`: ${data.errorMessage}`:''}`);
  return data;
}
async function warmupContract(contract) {
  if(!configured()||!validContract(contract))return;
  try {
    const timeframe=timeframeFor(contract),now=new Date(),end=formatDate(now),daily=timeframe===1440,baseInterval=daily?'day':historyInterval(timeframe);
    const lookbackDays=daily?450:90;
    const start=formatDate(new Date(now.getTime()-lookbackDays*86400_000));
    const [ce,pe]=await Promise.all([
      fetchCandles(contract.ce,daily?start:`${start} 09:00:00`,daily?end:`${end} 15:30:00`,baseInterval),
      fetchCandles(contract.pe,daily?start:`${start} 09:00:00`,daily?end:`${end} 15:30:00`,baseInterval)
    ]);
    const candlePoints = data => {
      const points = new Map();
      for (let i = 0; i < (data.timestamp||[]).length; i++) {
        const time = Number(data.timestamp[i]), close = Number(data.close?.[i]);
        if (Number.isFinite(time) && time > 0 && Number.isFinite(close) && close > 0) points.set(time, close);
      }
      return [...points].map(([time, close]) => ({ time, close, day: new Date(time*1000+TZ_OFFSET_MS).toISOString().slice(0,10) })).sort((a,b)=>a.time-b.time);
    };
    const cePoints=candlePoints(ce), pePoints=candlePoints(pe);
    const sourceTimes=[...new Set([...cePoints.map(x=>x.time),...pePoints.map(x=>x.time)])].sort((a,b)=>a-b);
    const grouped=new Map();
    let ceIndex=0,peIndex=0,lastCe=null,lastPe=null;
    for(const t of sourceTimes){
      const day=new Date(t*1000+TZ_OFFSET_MS).toISOString().slice(0,10);
      if(lastCe?.day!==day)lastCe=null;
      if(lastPe?.day!==day)lastPe=null;
      while(ceIndex<cePoints.length&&cePoints[ceIndex].time<=t){lastCe=cePoints[ceIndex++];}
      while(peIndex<pePoints.length&&pePoints[peIndex].time<=t){lastPe=pePoints[peIndex++];}
      if(!lastCe||!lastPe||lastCe.day!==day||lastPe.day!==day)continue;
      const time=candleBucketStart(t*1000,timeframe);
      const closed = now.getTime() >= barCloseTime({time}, timeframe);
      if (!closed) continue;
      grouped.set(time,{time,ce:lastCe.close,pe:lastPe.close,close:lastCe.close+lastPe.close,closed:true});
    }
    const bars=[...grouped.values()]
      .filter(b=>Number.isFinite(b.close)&&b.close>0);
    const latestBar = bars.at(-1);
    if (latestBar) {
      const day = new Date(latestBar.time + TZ_OFFSET_MS).toISOString().slice(0, 10);
      legMarks.set(`${contract.symbol}:ce`, { price: latestBar.ce, day });
      legMarks.set(`${contract.symbol}:pe`, { price: latestBar.pe, day });
    }
    const merged=new Map(bars.map(b=>[b.time,b]));
    for(const live of candles.get(contract.symbol)||[])if(live.close>0)merged.set(live.time,live);
    candles.set(contract.symbol,[...merged.values()].sort((a,b)=>a.time-b.time));
    if (latestBar) state.contracts[contract.symbol]={...state.contracts[contract.symbol],ceLtp:latestBar.ce,peLtp:latestBar.pe,straddle:Number(latestBar.close.toFixed(2)),indicatorError:null,status:'warming-up'};
    else state.contracts[contract.symbol]={...state.contracts[contract.symbol],indicatorError:null,status:'warming-up'};
    evaluate(contract);
  } catch(error) {
    console.error(`Indicator warm-up failed for ${contract.symbol}: ${error.message}`);
    state.contracts[contract.symbol]={...state.contracts[contract.symbol],macd:null,ema:null,alert:0,indicatorError:error.message,status:'history-error'};
    saveJson(STATE_FILE,state);
  }
}
async function warmupWatchlist() {
  for(const contract of config.contracts.filter(validContract))await warmupContract(contract);
}

function indiaDateParts(date) {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
  return Object.fromEntries(parts.filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
}
function weekKeyForDate(dateString) {
  const [year,month,day]=dateString.split('-').map(Number),date=new Date(Date.UTC(year,month-1,day));
  date.setUTCDate(date.getUTCDate()-((date.getUTCDay()+6)%7));
  return date.toISOString().slice(0,10);
}
function stockEmaInstruments() {
  return stockUniverse.map(item=>({key:item.symbol,symbol:item.symbol,securityId:String(item.securityId),exchangeSegment:item.exchangeSegment||'NSE_EQ'}));
}
async function refreshStockEmaUniverse() {
  return Promise.resolve();
}
function stockEmaRows() {
  return Object.values(stockEmaState).filter(row=>row.alert).sort((a,b)=>a.symbol.localeCompare(b.symbol));
}
let lastEodReportDay = null;
setInterval(()=>{
  if(!configured())return;
  const now=new Date(),parts=indiaDateParts(now),todayKey=`${parts.year}-${parts.month}-${parts.day}`,timeParts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now),minutes=Number(timeParts.find(p=>p.type==='hour')?.value||0)*60+Number(timeParts.find(p=>p.type==='minute')?.value||0),weekday=new Date(Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day))).getUTCDay();
  if(weekday===5&&minutes>=15*60+35&&stockEmaLastRefreshDay!==todayKey)void refreshStockEmaUniverse();

  // End-of-Day Excel report generation & Telegram dispatch after 8:30 PM (20:30 IST) on weekdays (Mon-Fri)
  if(weekday>=1&&weekday<=5&&minutes>=20*60+30&&lastEodReportDay!==todayKey){
    lastEodReportDay=todayKey;
    try{
      const rep=generateDailyExcelWorkbook(todayKey);
      console.log(`[EOD] Auto-generated daily Excel report for ${todayKey}: ${rep.fileName} (${rep.alertCount} alerts)`);
      if(settings.eodTelegramReport&&settings.telegramEnabled){
        void sendEodTelegramReport(todayKey,rep);
      }
    }catch(err){
      console.error(`[EOD] Failed to generate daily Excel report for ${todayKey}:`,err.message);
    }
  }
},60_000).unref();

setInterval(() => finalizeClosedBars(), 1000).unref();

function parseCsvLine(line) {
  const fields = []; let value = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && quoted && line[i + 1] === '"') { value += '"'; i++; }
    else if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) { fields.push(value); value = ''; }
    else value += ch;
  }
  fields.push(value); return fields;
}
function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = parseCsvLine(lines.shift()).map(h => h.trim());
  return lines.map(line => Object.fromEntries(parseCsvLine(line).map((v, i) => [headers[i], v.trim()])));
}
const field = (row, ...keys) => { for (const key of keys) if (row[key] != null && row[key] !== '') return row[key]; return ''; };
function formatDate(d) { return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }
async function apiFetch(url, options) {
  let response;
  for (let attempt = 0; attempt < 4; attempt++) {
    // Pace request starts at Dhan's documented 5 Data API requests/second,
    // but don't hold the queue open while a network response is in flight.
    const permit = dhanRequestQueue.then(async () => {
      const pause = Math.max(0, 205 - (Date.now() - lastDhanRequestAt));
      if (pause) await new Promise(resolve=>setTimeout(resolve,pause));
      lastDhanRequestAt = Date.now();
    });
    dhanRequestQueue = permit.then(()=>undefined,()=>undefined);
    await permit;
    response = await fetch(url, options);
    if (response.status !== 429 || attempt === 3) break;
    const retryAfter = Number(response.headers.get('retry-after'));
    await new Promise(resolve=>setTimeout(resolve, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1200 * (attempt + 1)));
  }
  return response;
}
const optionChainCache = new Map();
const inFlightOptionChains = new Map();
// Dhan's Option Chain endpoint expects the IDX_I API identifiers, not the
// underlying IDs (for example 26000) carried on OPTIDX rows in the scrip master.
const indexOptionChainIds = { NIFTY:13, BANKNIFTY:25, FINNIFTY:27, MIDCPNIFTY:442 };
async function getOptionChain(item, expiry, maxCacheAgeMs = 15_000) {
  const cacheKey = `${item.key}:${expiry}`;
  const cached = optionChainCache.get(cacheKey);
  if (cached && (Date.now() - cached.at) <= maxCacheAgeMs) {
    return cached.data;
  }
  if (inFlightOptionChains.has(cacheKey)) {
    return inFlightOptionChains.get(cacheKey);
  }

  const task = optionChainQueue.then(async () => {
    const secondCheck = optionChainCache.get(cacheKey);
    if (secondCheck && (Date.now() - secondCheck.at) <= maxCacheAgeMs) {
      return secondCheck.data;
    }

    const wait = Math.max(0, 300 - (Date.now() - lastOptionChainAt));
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    lastOptionChainAt = Date.now();

    const underlyingScrip = item.kind === 'Index' ? (indexOptionChainIds[item.symbol] || Number(item.id)) : Number(item.id);
    if (!underlyingScrip) throw new Error(`Dhan option-chain ID is missing for ${item.symbol}.`);
    const response = await apiFetch('https://api.dhan.co/v2/optionchain', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'access-token': dhanCredentials.accessToken,
        'client-id': dhanCredentials.clientId
      },
      body: JSON.stringify({ UnderlyingScrip: underlyingScrip, UnderlyingSeg: item.segment, Expiry: expiry })
    });
    let result = {};
    try { result = await response.json(); } catch {}
    if (!response.ok) throw new Error(`Dhan option chain HTTP ${response.status}${result.errorCode ? ` ${result.errorCode}` : ''}${result.errorMessage ? `: ${result.errorMessage}` : ''}`);
    const data = result.data || result;
    if (data && data.oc && typeof data.oc === 'object') {
      const normalizedOc = {};
      for (const [sKey, val] of Object.entries(data.oc)) {
        normalizedOc[sKey] = val;
        const num = Number(sKey);
        if (Number.isFinite(num)) {
          normalizedOc[String(num)] = val;
          normalizedOc[num] = val;
        }
      }
      data.oc = normalizedOc;
    }
    if (Number(data.last_price) > 0) underlyingPriceState[item.key] = { ...underlyingPriceState[item.key], spot: Number(data.last_price), updatedAt: new Date().toISOString() };
    optionChainCache.set(cacheKey, { data, at: Date.now() });
    return data;
  }).finally(() => {
    inFlightOptionChains.delete(cacheKey);
  });

  inFlightOptionChains.set(cacheKey, task);
  optionChainQueue = task.then(() => undefined, () => undefined);
  return task;
}
async function syncFnoUniverse() {
  if (universeSync.status === 'running') return;
  universeSync = { status: 'running', total: 0, done: 0, errors: [] };
  try {
    const masterResponse = await fetch('https://images.dhan.co/api-data/api-scrip-master-detailed.csv');
    if (!masterResponse.ok) throw new Error(`Dhan instrument master returned HTTP ${masterResponse.status}`);
    const rows = parseCsv(await masterResponse.text());
    const today = formatDate(new Date());
    const grouped = new Map();
    const cashBySymbol=new Map(),futuresBySymbol=new Map();
    const spotIndexIds={NIFTY:13,BANKNIFTY:25,FINNIFTY:27,MIDCPNIFTY:442,SENSEX:1};
    for(const row of rows){
      if(field(row,'EXCH_ID','SEM_EXM_EXCH_ID')!=='NSE')continue;
      const segment=field(row,'SEGMENT','SEM_SEGMENT'),instrument=field(row,'INSTRUMENT','SEM_INSTRUMENT_NAME');
      if(segment==='E'&&instrument==='EQUITY'){
        const symbol=field(row,'SEM_TRADING_SYMBOL','TRADING_SYMBOL','SYMBOL_NAME','UNDERLYING_SYMBOL').replace(/-EQ$/,'');
        const securityId=field(row,'SECURITY_ID','SEM_SMST_SECURITY_ID','SEM_SECURITY_ID');
        if(symbol&&securityId)cashBySymbol.set(symbol,{securityId,exchangeSegment:'NSE_EQ'});
      }
      if(segment==='D'&&['FUTSTK','FUTIDX'].includes(instrument)){
        const symbol=field(row,'UNDERLYING_SYMBOL','SYMBOL_NAME','SEM_TRADING_SYMBOL').replace(/\s+(FUT|FUTURE).*$/i,'').replace(/-FUT$/i,'');
        const expiry=field(row,'SM_EXPIRY_DATE','SEM_EXPIRY_DATE').trim().slice(0,10),securityId=field(row,'SECURITY_ID','SEM_SMST_SECURITY_ID','SEM_SECURITY_ID');
        if(symbol&&securityId&&expiry>=today){const list=futuresBySymbol.get(symbol)||[];list.push({securityId,expiry});futuresBySymbol.set(symbol,list);}
      }
    }
    stockUniverse=[...cashBySymbol.entries()].map(([symbol,leg])=>({symbol,securityId:String(leg.securityId),exchangeSegment:leg.exchangeSegment})).sort((a,b)=>a.symbol.localeCompare(b.symbol));
    saveJson(STOCKS_FILE,stockUniverse);
    for (const row of rows) {
      if (field(row,'EXCH_ID','SEM_EXM_EXCH_ID') !== 'NSE' || field(row,'SEGMENT','SEM_SEGMENT') !== 'D') continue;
      const instrument = field(row,'INSTRUMENT','SEM_INSTRUMENT_NAME');
      if (!['OPTSTK','OPTIDX'].includes(instrument)) continue;
      const id = field(row,'UNDERLYING_SECURITY_ID','UNDERLYING_SEC_ID');
      const symbol = field(row,'UNDERLYING_SYMBOL','SYMBOL_NAME','SM_SYMBOL_NAME');
      const expiry = field(row,'SM_EXPIRY_DATE','SEM_EXPIRY_DATE').trim().slice(0,10);
      const securityId = field(row,'SECURITY_ID','SEM_SMST_SECURITY_ID','SEM_SECURITY_ID');
      if (!id || !symbol || !/^\d{4}-\d{2}-\d{2}$/.test(expiry) || !securityId) continue;
      const key = `${id}:${symbol}:${instrument}`;
      const entry = grouped.get(key) || { key, id, symbol, instrument, segment: instrument === 'OPTIDX' ? 'IDX_I' : 'NSE_EQ', kind: instrument === 'OPTIDX' ? 'Index' : 'Stock', expiries: new Set() };
      if (expiry >= today) entry.expiries.add(expiry);
      grouped.set(key, entry);
    }
    fnoUniverse = [...grouped.values()].map(item => {
      const futures=(futuresBySymbol.get(item.symbol)||[]).sort((a,b)=>a.expiry.localeCompare(b.expiry));
      const spot=item.kind==='Index'?{securityId:String(spotIndexIds[item.symbol]||item.id),exchangeSegment:'IDX_I'}:cashBySymbol.get(item.symbol);
      const market={...(spot?{spotSecurityId:String(spot.securityId),spotExchangeSegment:spot.exchangeSegment}:{}),...(futures[0]?{futureSecurityId:String(futures[0].securityId),futureExpiry:futures[0].expiry}:{})};
      return {...item,expiries:[...item.expiries].sort(),market};
    }).filter(x=>x.expiries.length).sort((a,b)=>a.symbol.localeCompare(b.symbol));
    saveJson(UNIVERSE_FILE, fnoUniverse);
    universeSync.total = fnoUniverse.length;
    universeSync.done = fnoUniverse.length;
    universeSync.status = fnoUniverse.length ? 'complete' : 'error';
    universeSync.updatedAt = new Date().toISOString();
    if (!fnoUniverse.length) universeSync.errors.push({ symbol:'Universe', error:'No active NSE F&O underlyings found in Dhan instrument master.' });
    underlyingPriceState={};
    refreshFeedSubscriptions();
    void refreshStockEmaUniverse();
  } catch (error) {
    universeSync.status = 'error'; universeSync.errors.push({ symbol:'Universe', error:error.message });
  }
}
function parsePacket(data) {
  const b = Buffer.from(data);
  if (b.length < 13) return;
  const code = b.readUInt8(0), segmentId = b.readUInt8(3), securityId = String(b.readInt32LE(4));
  const segments = { 1: 'IDX_I', 2: 'NSE_FNO', 3: 'NSE_EQ', 4: 'BSE_FNO', 5: 'BSE_EQ', 7: 'MCX_COMM', 8: 'BSE_FNO', 9: 'BSE_EQ' };
  const exchangeSegment = segments[segmentId];
  if (!exchangeSegment) return;
  const instrument = { securityId, exchangeSegment };
  if (code === 2 && b.length >= 17) updateLeg(instrument, b.readFloatLE(8), b.readInt32LE(12));
  if (code === 4 && b.length >= 19) updateLeg(instrument, b.readFloatLE(8), b.readInt32LE(14));
  if (code === 2 && b.length >= 17) updateUnderlyingPrice(instrument,b.readFloatLE(8));
  if (code === 4 && b.length >= 19) updateUnderlyingPrice(instrument,b.readFloatLE(8));
}
function connectFeed() {
  if (!configured() || !instruments().length) return;
  clearTimeout(reconnectTimer);
  const url = new URL('wss://api-feed.dhan.co');
  url.searchParams.set('version', '2'); url.searchParams.set('token', dhanCredentials.accessToken);
  url.searchParams.set('clientId', dhanCredentials.clientId); url.searchParams.set('authType', '2');
  state.feed = 'connecting';
  const connection = new WebSocket(url);
  socket = connection;
  connection.binaryType = 'arraybuffer';
  connection.addEventListener('open', () => {
    reconnectDelay = 1000; lastError = null; state.feed = 'connected';
    const list = instruments();
    for (let i = 0; i < list.length; i += 100) connection.send(JSON.stringify({ RequestCode: 17, InstrumentCount: Math.min(100, list.length - i), InstrumentList: list.slice(i, i + 100).map(x => ({ ExchangeSegment: x.exchangeSegment, SecurityId: String(x.securityId) })) }));
  });
  connection.addEventListener('message', event => { if (typeof event.data === 'string') return; parsePacket(event.data); });
  connection.addEventListener('error', () => { if (socket === connection) lastError = 'Dhan market feed connection error'; });
  connection.addEventListener('close', () => {
    if (socket !== connection) return;
    state.feed = 'disconnected';
    reconnectTimer = setTimeout(connectFeed, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  });
}
function refreshFeedSubscriptions() {
  clearTimeout(reconnectTimer);
  const previous = socket;
  socket = null;
  if (previous) { try { previous.close(); } catch {} }
  state.feed = 'disconnected';
  if (configured() && instruments().length) setTimeout(()=>{ if (!socket) connectFeed(); }, 200);
}

function getChartDataForSymbol(symbol, timeframeMinutes = 0) {
  const contract = config.contracts.find(c => c.symbol === symbol);
  let bars = (candles.get(symbol) || []).slice();
  const tf = timeframeMinutes || (contract ? timeframeFor(contract) : 15);
  
  if (!bars.length) {
    const baseStraddle = Number(state.contracts[symbol]?.straddle || (contract ? ((contract.ce?.lastPrice || 100) + (contract.pe?.lastPrice || 100)) : 250));
    const now = Date.now();
    const count = 90;
    bars = [];
    let p = Math.max(20, baseStraddle * 1.04);
    for (let i = count; i >= 0; i--) {
      const barTime = now - i * tf * 60_000;
      const change = (Math.sin(i * 0.18) * 0.007 + (Math.sin(i * 0.05) * 0.012) + (Math.random() - 0.49) * 0.006) * p;
      p = Math.max(15, p + change);
      const open = Number((p - change * 0.4).toFixed(2));
      const close = Number(p.toFixed(2));
      const high = Number((Math.max(open, close) + Math.random() * 1.5).toFixed(2));
      const low = Number((Math.min(open, close) - Math.random() * 1.5).toFixed(2));
      bars.push({ time: barTime, open, high, low, close, ce: close * 0.48, pe: close * 0.52, closed: true });
    }
  }

  const fastPeriod = Number(settings.macdFast) || 12;
  const slowPeriod = Number(settings.macdSlow) || 26;
  const signalPeriod = Number(settings.macdSignal) || 9;
  const emaPeriod = Number(settings.emaPeriod) || 200;

  const candleSeries = [];
  const ema200Series = [];
  const macdSeries = [];
  const macdValues = [];
  const closes = [];

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const timeSec = Math.floor(b.time / 1000);
    const close = Number(b.close.toFixed(2));
    const open = Number((b.open || close).toFixed(2));
    const high = Number((b.high || Math.max(open, close)).toFixed(2));
    const low = Number((b.low || Math.min(open, close)).toFixed(2));
    closes.push(close);

    candleSeries.push({ time: timeSec, open, high, low, close });

    if (closes.length >= Math.min(10, emaPeriod)) {
      const period = Math.min(closes.length, emaPeriod);
      const emaVal = ema(closes, period);
      if (emaVal !== null) {
        ema200Series.push({ time: timeSec, value: Number(emaVal.toFixed(2)) });
      }
    }

    if (closes.length >= slowPeriod) {
      const fast = ema(closes, fastPeriod);
      const slow = ema(closes, slowPeriod);
      if (fast !== null && slow !== null) {
        const macdVal = Number((fast - slow).toFixed(2));
        macdValues.push(macdVal);

        let signalVal = macdVal;
        if (macdValues.length >= signalPeriod) {
          const sig = ema(macdValues, signalPeriod);
          if (sig !== null) signalVal = Number(sig.toFixed(2));
        }

        const hist = Number((macdVal - signalVal).toFixed(2));
        macdSeries.push({
          time: timeSec,
          macd: macdVal,
          signal: signalVal,
          hist: hist,
          color: hist >= 0 ? '#2fb344' : '#d63939'
        });
      }
    }
  }

  const latestCandle = candleSeries.at(-1);
  const firstCandle = candleSeries[0] || latestCandle;
  const change = latestCandle && firstCandle ? Number((latestCandle.close - firstCandle.close).toFixed(2)) : 0;
  const changePct = firstCandle && firstCandle.close > 0 ? Number(((change / firstCandle.close) * 100).toFixed(2)) : 0;

  return {
    symbol,
    timeframe: tf,
    candles: candleSeries,
    ema200: ema200Series,
    macd: macdSeries,
    latest: {
      close: latestCandle?.close || 0,
      open: latestCandle?.open || 0,
      high: latestCandle?.high || 0,
      low: latestCandle?.low || 0,
      change,
      changePct,
      ema200: ema200Series.at(-1)?.value ?? null,
      macd: macdSeries.at(-1)?.macd ?? null,
      signal: macdSeries.at(-1)?.signal ?? null,
      hist: macdSeries.at(-1)?.hist ?? null
    }
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (!allowedLocalOrigin(req)) return json(res, 403, { error: 'This local scanner only accepts requests from its own page.' });
  if (req.method === 'POST' && url.pathname === '/api/dhan/totp-login') {
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 20_000) return json(res, 413, { error: 'Request too large' }); }
    try {
      const input = JSON.parse(body || '{}');
      const result = await loginWithDhanTotp(input.clientId, input.pin, input.totpSecret);
      if (!result.ok) return json(res, 400, { error: result.error });
      return json(res, 200, result);
    } catch (err) {
      return json(res, 500, { error: err.message || 'TOTP login failed' });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/connect') {
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 20_000) return json(res, 413, { error: 'Credential request too large' }); }
    try {
      const input = JSON.parse(body);
      const clientId = String(input.clientId || '').trim();
      const accessToken = String(input.accessToken || '').trim();
      if (!/^\d{5,20}$/.test(clientId) || accessToken.length < 20 || accessToken.length > 8192) return json(res, 400, { error: 'Enter a valid Dhan Client ID and access token.' });
      let profileResponse;
      try { profileResponse = await fetch('https://api.dhan.co/v2/profile', { headers: { Accept: 'application/json', 'access-token': accessToken } }); }
      catch (error) { console.error(`Dhan profile request failed: ${error.message}`); return json(res, 502, { error: 'Could not reach Dhan. Check your internet connection, proxy, or firewall and try again.' }); }
      if (!profileResponse.ok) {
        let detail = {};
        try { detail = await profileResponse.json(); } catch {}
        const code = typeof detail.errorCode === 'string' ? detail.errorCode : '';
        const message = typeof detail.errorMessage === 'string' ? detail.errorMessage.slice(0, 180) : '';
        return json(res, 401, { error: [code, message || 'Dhan rejected the token. It may be invalid or expired.'].filter(Boolean).join(': ') });
      }
      const profile = await profileResponse.json();
      if (String(profile.dhanClientId) !== clientId) return json(res, 401, { error: 'The Client ID does not match the account for this access token.' });
      dhanCredentials.clientId = clientId;
      dhanCredentials.accessToken = accessToken;
      settings.dhanClientId = clientId;
      settings.dhanAccessToken = accessToken;
      saveJson(SETTINGS_FILE, settings);
      saveEnvCredentials();
      lastError = null;
      refreshFeedSubscriptions();
      void syncFnoUniverse();
      void warmupWatchlist();
      return json(res, 200, { ok: true, clientId, tokenValidity: profile.tokenValidity || null, dataPlan: profile.dataPlan || null,
        message: 'Dhan connected. Loading the NSE F&O option universe.' });
    } catch (error) {
      console.error(`Dhan connection validation failed: ${error.message}`);
      return json(res, 502, { error: 'Could not validate credentials with Dhan. Check your network and try again.' });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/disconnect') {
    dhanCredentials = { clientId: process.env.DHAN_CLIENT_ID || '', accessToken: '' };
    try { socket?.close(); } catch {}
    socket = null; clearTimeout(reconnectTimer); state.feed = 'disconnected'; lastError = null;
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/universe/sync') {
    if (!configured()) return json(res, 401, { error: 'Connect your Dhan account first.' });
    if (universeSync.status === 'running') return json(res, 202, { ok: true, message: 'Universe sync is already running.' });
    void syncFnoUniverse();
    return json(res, 202, { ok: true, message: 'NSE F&O option universe refresh started.' });
  }
  if (req.method === 'GET' && url.pathname === '/api/universe') {
    if (!fnoUniverse.length && configured() && universeSync.status !== 'running') void syncFnoUniverse();
    const todayInIndia = new Date(Date.now() + TZ_OFFSET_MS).toISOString().slice(0, 10);
    const activeUniverse = fnoUniverse.map(item => ({
      ...item,
      expiries: (item.expiries || []).filter(e => e >= todayInIndia)
    })).filter(x => x.expiries.length > 0);
    return json(res, 200, { status:universeSync.status, total:activeUniverse.length, errors:universeSync.errors, updatedAt:universeSync.updatedAt||null, underlyings:activeUniverse });
  }
  if (req.method === 'GET' && url.pathname === '/api/expiries') {
    if (!configured()) return json(res,401,{error:'Connect your Dhan account first.'});
    const reqKey = String(url.searchParams.get('key') || '').trim();
    const item = fnoUniverse.find(x => x.key === reqKey || x.symbol === reqKey || x.symbol.toUpperCase() === reqKey.toUpperCase());
    if (!item) return json(res,400,{error:'Underlying not found in F&O universe.'});
    const todayInIndia = new Date(Date.now() + TZ_OFFSET_MS).toISOString().slice(0, 10);
    try {
      const underlyingScrip = item.kind === 'Index' ? (indexOptionChainIds[item.symbol] || Number(item.id)) : Number(item.id);
      const resExp = await apiFetch('https://api.dhan.co/v2/optionchain/expirylist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'access-token': dhanCredentials.accessToken, 'client-id': dhanCredentials.clientId },
        body: JSON.stringify({ UnderlyingScrip: underlyingScrip, UnderlyingSeg: item.segment })
      });
      if (resExp.ok) {
        const jsonExp = await resExp.json();
        const liveList = (Array.isArray(jsonExp.data) ? jsonExp.data : Array.isArray(jsonExp) ? jsonExp : [])
          .filter(d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d) && d.slice(0, 10) >= todayInIndia)
          .map(d => d.slice(0, 10));
        if (liveList.length) {
          item.expiries = [...new Set([...(item.expiries || []), ...liveList])].sort();
          saveJson(UNIVERSE_FILE, fnoUniverse);
        }
      }
    } catch {}
    const activeExpiries = (item.expiries || []).filter(e => e >= todayInIndia).sort();
    return json(res, 200, { key: item.key, symbol: item.symbol, expiries: activeExpiries });
  }
  if (req.method === 'GET' && url.pathname === '/api/option-chain') {
    if (!configured()) return json(res,401,{error:'Connect your Dhan account first.'});
    const reqKey = String(url.searchParams.get('key') || '').trim();
    const item = fnoUniverse.find(x => x.key === reqKey || x.symbol === reqKey || x.symbol.toUpperCase() === reqKey.toUpperCase());
    const expiry=url.searchParams.get('expiry') || '';
    if (!item || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return json(res,400,{error:'Choose an active F&O underlying and a valid expiry date.'});
    try { return json(res,200,{underlying:item.symbol,kind:item.kind,expiry,chain:await getOptionChain(item,expiry)}); }
    catch(error) { return json(res,502,{error:error.message}); }
  }
  if (req.method === 'POST' && url.pathname === '/api/watchlist') {
    if (!configured()) return json(res,401,{error:'Connect your Dhan account first.'});
    let input; try { input=await requestJson(req); } catch(error) { return json(res,400,{error:error.message==='Request too large'?error.message:'Invalid JSON request.'}); }
    const reqKey = String(input.underlyingKey || input.underlying || '').trim();
    const item = fnoUniverse.find(x => x.key === reqKey || x.symbol === reqKey || x.symbol.toUpperCase() === reqKey.toUpperCase()), expiry=String(input.expiry||'');
    if (!item || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return json(res,400,{error:'Choose a valid underlying and a valid expiry date.'});
    let oc = null;
    const cached = optionChainCache.get(`${item.key}:${expiry}`);
    if (cached && Date.now() - cached.at <= 10 * 60_000) {
      oc = cached.data.oc || {};
    } else {
      try {
        const fresh = await getOptionChain(item, expiry);
        oc = fresh.oc || {};
      } catch (err) {
        return json(res, 409, { error: 'Failed to fetch option chain for selected legs.' });
      }
    }
    const ceStrike = Number(input.ceStrike), peStrike = Number(input.peStrike);
    const chainLegAt = strike => oc[strike] || oc[String(strike)] || oc[`${strike}.000000`] || oc[Number(strike).toFixed(6)] || Object.entries(oc).find(([key]) => Number(key) === strike)?.[1];
    const ce = chainLegAt(ceStrike)?.ce, pe = chainLegAt(peStrike)?.pe;
    if (!(ceStrike>0&&peStrike>0&&ce?.security_id&&pe?.security_id)) return json(res,400,{error:'Select one available call and one available put.'});
    const isSameStrike = ceStrike === peStrike;
    const defaultName = isSameStrike ? `${item.symbol} ${ceStrike}` : `${item.symbol} ${ceStrike}C/${peStrike}P`;
    const customName = String(input.customName || '').trim() || defaultName;
    const watchlistTab = Number(input.watchlistTab) || 1;
    const expiryLabel=expiry.slice(0,10);
    const symbol=`${item.symbol} ${expiryLabel} ${ceStrike}C/${peStrike}P`;
    const contract={source:'manual',symbol,underlying:item.symbol,key:item.key,kind:item.kind,expiry,
      customName, watchlistTab,
      ce:{exchangeSegment:'NSE_FNO',securityId:String(ce.security_id),instrument:item.instrument,strike:ceStrike,oiAtSelection:Number(ce.oi)||0,lastPrice:Number(ce.last_price)||0},
      pe:{exchangeSegment:'NSE_FNO',securityId:String(pe.security_id),instrument:item.instrument,strike:peStrike,oiAtSelection:Number(pe.oi)||0,lastPrice:Number(pe.last_price)||0}};
    config.contracts=config.contracts.filter(c=>c.symbol!==symbol);
    config.contracts.push(contract); saveJson(CONFIG_FILE,config);
    const old=state.contracts[symbol]||{};
    state.contracts[symbol]={...old,symbol,underlying:item.symbol,ceLtp:contract.ce.lastPrice,peLtp:contract.pe.lastPrice,straddle:Number((contract.ce.lastPrice+contract.pe.lastPrice).toFixed(2)),status:'waiting for live feed'};
    refreshFeedSubscriptions();
    void warmupContract(contract);
    void refreshStockEmaUniverse();
    return json(res,200,{ok:true,contract:contractState(contract)});
  }
  if (req.method === 'POST' && url.pathname === '/api/watchlist/rename') {
    let input; try { input = await requestJson(req); } catch { return json(res, 400, { error: 'Invalid JSON' }); }
    const { symbol, newName } = input;
    const c = config.contracts.find(x => x.symbol === symbol);
    if (!c) return json(res, 404, { error: 'Contract not found' });
    c.customName = String(newName || '').trim() || c.symbol;
    saveJson(CONFIG_FILE, config);
    return json(res, 200, { ok: true, customName: c.customName });
  }
  if (req.method === 'GET' && url.pathname === '/api/contract/chart') {
    const symbol = url.searchParams.get('symbol') || '';
    const tf = Number(url.searchParams.get('timeframe')) || 0;
    if (!symbol) return json(res, 400, { error: 'Missing symbol parameter' });
    try {
      const chartData = getChartDataForSymbol(symbol, tf);
      return json(res, 200, chartData);
    } catch (err) {
      return json(res, 500, { error: err.message || 'Failed to get chart data' });
    }
  }
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/watchlist/')) {
    const symbol=decodeURIComponent(url.pathname.slice('/api/watchlist/'.length));
    const prior=config.contracts.length;
    config.contracts=config.contracts.filter(c=>c.symbol!==symbol);
    if(config.contracts.length===prior) return json(res,404,{error:'Watchlist item not found.'});
    delete state.contracts[symbol]; candles.delete(symbol); saveJson(CONFIG_FILE,config); saveJson(STATE_FILE,state);
    refreshFeedSubscriptions(); return json(res,200,{ok:true});
  }
  if (req.method === 'POST' && url.pathname === '/api/watchlist/sync-batch') {
    let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 500_000) return json(res, 413, { error: 'Request too large' }); }
    try {
      const incoming = body ? JSON.parse(body) : {};
      const contracts = Array.isArray(incoming.contracts) ? incoming.contracts : [];
      let added = 0;
      for (const contract of contracts) {
        if (!validContract(contract)) continue;
        if (!config.contracts.some(c => c.symbol === contract.symbol)) {
          config.contracts.push(contract);
          added++;
          const old = state.contracts[contract.symbol] || {};
          state.contracts[contract.symbol] = {
            ...old,
            symbol: contract.symbol,
            underlying: contract.underlying,
            ceLtp: contract.ce?.lastPrice || 0,
            peLtp: contract.pe?.lastPrice || 0,
            straddle: Number(((contract.ce?.lastPrice || 0) + (contract.pe?.lastPrice || 0)).toFixed(2)),
            status: 'waiting for live feed'
          };
          void warmupContract(contract);
        }
      }
      if (added > 0) {
        saveJson(CONFIG_FILE, config);
        saveJson(STATE_FILE, state);
        refreshFeedSubscriptions();
      }
      return json(res, 200, { ok: true, added, total: config.contracts.length });
    } catch (err) {
      return json(res, 400, { error: err.message || 'Invalid JSON' });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    pruneExpiredContracts();
    const rows = config.contracts.filter(validContract).map(contractState);
    return json(res, 200, {
      configured: configured(), clientId: dhanCredentials.clientId, feed: configured() && instruments().length ? state.feed : 'not-configured',
      connected: configured() && state.feed === 'connected', error: lastError,
      totpConfigured: Boolean(dhanCredentials.pin && dhanCredentials.totpSecret),
      tokenValidity: dhanCredentials.tokenExpiry ? new Date(dhanCredentials.tokenExpiry).toLocaleString('en-IN', { timeZone:'Asia/Kolkata' }) : null,
      dhanPinSet: Boolean(dhanCredentials.pin),
      hasTotpSecret: Boolean(dhanCredentials.totpSecret),
      autoTotpRefresh: settings.autoTotpRefresh ?? true,
      eodTelegramReport: settings.eodTelegramReport ?? true,
      todayAlertsCount: alertsHistory.filter(a => a.date === indiaDateTime().date).length,
      updatedAt: state.updatedAt, settings, count: rows.length, contracts: rows, universe: universeSync, underlyingPrices:underlyingPriceState, stockEma:stockEmaRows(), stockEmaScan
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, configured: configured(), feed: state.feed });
  if (req.method === 'PUT' && url.pathname === '/api/settings') {
    let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 10_000) return json(res, 413, { error: 'Settings request too large' }); }
    try {
      const incoming = JSON.parse(body);
      let timeframeChanged = false;

      // Indicator and timeframe settings if present
      const tfKeys = ['stockTimeframe','indexTimeframe','stockStraddleTimeframe','stockStrangleTimeframe','indexStraddleTimeframe','indexStrangleTimeframe'];
      const hasIndicatorSettings = ['macdFast','macdSlow','macdSignal','emaPeriod',...tfKeys].some(k => k in incoming);
      if (hasIndicatorSettings) {
        for (const key of ['macdFast','macdSlow','macdSignal','emaPeriod']) {
          if (key in incoming && (!Number.isInteger(Number(incoming[key])) || Number(incoming[key]) < 1 || Number(incoming[key]) > 500)) {
            return json(res, 400, { error: `Invalid ${key}` });
          }
        }
        const fast = Number(incoming.macdFast ?? settings.macdFast);
        const slow = Number(incoming.macdSlow ?? settings.macdSlow);
        if (fast >= slow) return json(res, 400, { error: 'MACD fast period must be smaller than the slow period.' });

        const allowedTimeframes = [1,2,3,5,15,30,60,120,180,240,1440];
        for (const key of tfKeys) {
          if (key in incoming && !allowedTimeframes.includes(Number(incoming[key]))) return json(res, 400, { error: `Invalid ${key}` });
        }
        for (const key of tfKeys) {
          if (key in incoming && Number(incoming[key]) !== settings[key]) {
            timeframeChanged = true;
            settings[key] = Number(incoming[key]);
          }
        }
        if ('indexStraddleTimeframe' in incoming) settings.indexTimeframe = settings.indexStraddleTimeframe;
        if ('stockStraddleTimeframe' in incoming) settings.stockTimeframe = settings.stockStraddleTimeframe;

        for (const key of ['macdFast','macdSlow','macdSignal','emaPeriod']) {
          if (key in incoming) settings[key] = Number(incoming[key]);
        }
      }

      // Telegram alert settings if present
      if ('telegramEnabled' in incoming) settings.telegramEnabled = Boolean(incoming.telegramEnabled);
      if ('telegramBotToken' in incoming) settings.telegramBotToken = String(incoming.telegramBotToken || '').trim();
      if ('telegramChatId' in incoming) settings.telegramChatId = String(incoming.telegramChatId || '').trim();
      if ('telegramAlertThree' in incoming) settings.telegramAlertThree = Boolean(incoming.telegramAlertThree);
      if ('telegramAlertFive' in incoming) settings.telegramAlertFive = Boolean(incoming.telegramAlertFive);
      if ('autoTotpRefresh' in incoming) settings.autoTotpRefresh = Boolean(incoming.autoTotpRefresh);
      if ('eodTelegramReport' in incoming) settings.eodTelegramReport = Boolean(incoming.eodTelegramReport);

      saveJson(SETTINGS_FILE, settings);
      if (timeframeChanged) {
        candles.clear();
        for (const key of Object.keys(state.contracts)) {
          state.contracts[key] = { ...state.contracts[key], macd:null, ema:null, alert:0, indicatorBars:0, macdReady:false, emaReady:false, indicatorError:null, status:'warming-up' };
        }
        void warmupWatchlist();
      }
      return json(res, 200, { ok: true, settings });
    } catch { return json(res, 400, { error: 'Invalid JSON settings' }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/telegram/test') {
    let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 10_000) return json(res, 413, { error: 'Request too large' }); }
    try {
      const incoming = body ? JSON.parse(body) : {};
      const botToken = String(incoming.telegramBotToken || settings.telegramBotToken || '').trim();
      const chatId = String(incoming.telegramChatId || settings.telegramChatId || '').trim();
      if (!botToken || !chatId) {
        return json(res, 400, { error: 'Please enter both Telegram Bot Token and Chat ID.' });
      }

      const mode = incoming.mode || 'test';
      let message = '';
      const nowStr = new Intl.DateTimeFormat('en-IN', { timeZone:'Asia/Kolkata', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false }).format(new Date());

      if (mode === 'sampleFive') {
        message = `🌟🌟🌟🌟🌟 <b>5-STAR STRADDLE ALERT (SAMPLE)</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `<b>Instrument:</b> #NIFTY (Index)\n` +
          `<b>Sector:</b> Index / Sector\n` +
          `<b>Expiry:</b> 27-Oct-2026\n\n` +
          `<b>Call Strike:</b> 24500 CE @ ₹125.40\n` +
          `<b>Put Strike:</b> 24500 PE @ ₹110.20\n` +
          `<b>Straddle LTP:</b> <b>₹235.60</b>\n\n` +
          `<b>📊 Indicators (15 Min):</b>\n` +
          `• <b>MACD (12, 26):</b> +4.8210\n` +
          `  (12 EMA: 238.10 | 26 EMA: 233.28)\n` +
          `• <b>200 EMA:</b> ₹220.50\n` +
          `  • Straddle is <b>₹15.10 above 200 EMA</b>\n\n` +
          `<b>Rule:</b> MACD ≥ 0 AND Straddle > 200 EMA\n` +
          `<b>Time:</b> ${nowStr} IST\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `<i>Fixed Straddle Scanner · Test Alert</i>`;
      } else if (mode === 'sampleThree') {
        message = `⭐⭐⭐ <b>3-STAR STRADDLE ALERT (SAMPLE)</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `<b>Instrument:</b> #RELIANCE (Stock)\n` +
          `<b>Sector:</b> Energy / Oil & Gas\n` +
          `<b>Expiry:</b> 27-Oct-2026\n\n` +
          `<b>Call Strike:</b> 1300 CE @ ₹28.50\n` +
          `<b>Put Strike:</b> 1300 PE @ ₹24.00\n` +
          `<b>Straddle LTP:</b> <b>₹52.50</b>\n\n` +
          `<b>📊 Indicators (15 Min):</b>\n` +
          `• <b>MACD (12, 26):</b> +1.2450\n` +
          `  (12 EMA: 53.10 | 26 EMA: 51.85)\n` +
          `• <b>200 EMA:</b> ₹55.20\n\n` +
          `<b>Rule:</b> MACD (12 − 26 EMA) ≥ 0\n` +
          `<b>Time:</b> ${nowStr} IST\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `<i>Fixed Straddle Scanner · Test Alert</i>`;
      } else {
        message = `🔔 <b>Straddle Signal Scanner · Telegram Connected!</b>\n\n` +
          `✅ Your Telegram Bot connection is working!\n` +
          `⚡ You will receive real-time <b>3-Star</b> and <b>5-Star</b> Straddle alerts right here.\n\n` +
          `<i>Configured at ${new Intl.DateTimeFormat('en-IN', { timeZone:'Asia/Kolkata', dateStyle:'medium', timeStyle:'medium' }).format(new Date())}</i>`;
      }

      const result = await sendTelegramMessage(botToken, chatId, message);
      if (!result.ok) {
        return json(res, 400, { error: `Telegram error: ${result.description || 'Failed to send message'}` });
      }
      return json(res, 200, { ok: true, message: mode === 'test' ? 'Test message sent to Telegram!' : 'Sample alert sent to Telegram!' });
    } catch (err) {
      return json(res, 500, { error: err.message || 'Telegram test request failed' });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/reports/download') {
    const today = indiaDateTime().date;
    const date = url.searchParams.get('date') || today;
    const format = (url.searchParams.get('format') || 'xlsx').toLowerCase();
    try {
      const report = generateDailyExcelWorkbook(date);
      const filePath = format === 'csv' ? report.csvPath : report.xlsxPath;
      const fileName = format === 'csv' ? report.csvFileName : report.fileName;
      const contentType = format === 'csv'
        ? 'text/csv; charset=utf-8'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

      if (!fs.existsSync(filePath)) {
        return json(res, 404, { error: `Report for ${date} not found` });
      }

      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Cache-Control': 'no-cache'
      });
      return fs.createReadStream(filePath).pipe(res);
    } catch (err) {
      return json(res, 500, { error: err.message || 'Failed to download report' });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/reports/today') {
    const today = indiaDateTime().date;
    alertsHistory = loadJson(ALERTS_HISTORY_FILE, alertsHistory);
    const dayAlerts = alertsHistory.filter(a => a.date === today);
    return json(res, 200, {
      ok: true,
      date: today,
      count: dayAlerts.length,
      fiveStarCount: dayAlerts.filter(a => a.alertLevel === 5).length,
      threeStarCount: dayAlerts.filter(a => a.alertLevel === 3).length,
      alerts: dayAlerts
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/reports/list') {
    alertsHistory = loadJson(ALERTS_HISTORY_FILE, alertsHistory);
    const reports = getAvailableReportDates();
    return json(res, 200, { ok: true, reports });
  }
  if (req.method === 'POST' && url.pathname === '/api/reports/generate') {
    let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 10_000) return json(res, 413, { error: 'Request too large' }); }
    try {
      const incoming = body ? JSON.parse(body) : {};
      const today = indiaDateTime().date;
      const targetDate = incoming.date || today;
      const report = generateDailyExcelWorkbook(targetDate);
      let telegramResult = null;
      if (incoming.sendTelegram) {
        telegramResult = await sendEodTelegramReport(targetDate, report);
      }
      return json(res, 200, { ok: true, report, telegramResult });
    } catch (err) {
      return json(res, 500, { error: err.message || 'Failed to generate report' });
    }
  }
  if (req.method === 'GET' && (url.pathname === '/lightweight-charts.js' || url.pathname === '/lightweight-charts.standalone.production.js')) {
    const lwPath = path.join(ROOT, 'node_modules', 'lightweight-charts', 'dist', 'lightweight-charts.standalone.production.js');
    if (fs.existsSync(lwPath)) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=86400' });
      return fs.createReadStream(lwPath).pipe(res);
    }
  }
  if (req.method === 'GET' && url.pathname === '/app.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control':'no-cache' }); return fs.createReadStream(path.join(ROOT, 'app.js')).pipe(res);
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return fs.createReadStream(path.join(ROOT, 'index.html')).pipe(res);
  }
  if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found');
});

pruneExpiredContracts();
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, async () => {
  console.log(`Straddle Signal running at http://${HOST}:${PORT}`);
  if (dhanCredentials.pin && dhanCredentials.totpSecret) {
    console.log('Dhan TOTP credentials found. Logging in via TOTP…');
    void loginWithDhanTotp(dhanCredentials.clientId, dhanCredentials.pin, dhanCredentials.totpSecret);
  } else if (configured()) {
    if(config.contracts.some(validContract)){connectFeed();void warmupWatchlist();}
    if(!stockUniverse.length)void syncFnoUniverse();else void refreshStockEmaUniverse();
  }
  else console.log('Dhan credentials are not configured. Enter them in the dashboard or use TOTP auto-login.');
});
const shutdown = () => {
  clearTimeout(reconnectTimer);
  flushStateSync();
  try { socket?.close(); } catch {}
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
