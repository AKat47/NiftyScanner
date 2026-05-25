// api/scan.js — Batch candle fetch with shared MongoDB day-cache (Vercel)
//
// Accepts a comma-separated list of symbols and returns candle data for all
// of them in a single response. Cache hits (MongoDB) are resolved in parallel
// so a warm cache returns all data in one round-trip with no external API calls.
//
// Query params:
//   symbols  — comma-separated NSE symbols, e.g. TCS,INFY,WIPRO
//   from     — YYYY-MM-DD start date
//   to       — YYYY-MM-DD end date
//   force    — 1 to bypass cache and re-fetch from source
//
// Required env vars:
//   MONGODB_URI            — MongoDB Atlas connection string
//   ANGEL_API_KEY          — Angel One SmartAPI key        (optional)
//   ANGEL_CLIENT_ID        — Angel One client ID           (optional)
//   ANGEL_PASSWORD         — Angel One password            (optional)
//   ANGEL_TOTP_SECRET      — Angel One TOTP secret         (optional)

const https  = require('https');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

// ── MongoDB ────────────────────────────────────────────────────────────────
let _mongoClient = null;
async function getDb() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI env var not set');
  if (!_mongoClient) {
    _mongoClient = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
    await _mongoClient.connect();
  }
  return _mongoClient.db('niftyscanner');
}

function istDateString() {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().split('T')[0];
}

// ── Angel One ──────────────────────────────────────────────────────────────
function httpsPost(hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      { hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(payload) } },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } }); }
    );
    req.on('error', reject); req.write(payload); req.end();
  });
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } }); }
    );
    req.on('error', reject); req.end();
  });
}

function generateTOTP(secret) {
  const b32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const s = secret.toUpperCase().replace(/=+$/, '');
  let bits = '';
  for (const c of s) { const v = b32.indexOf(c); if (v >= 0) bits += v.toString(2).padStart(5, '0'); }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const key = Buffer.from(bytes);
  const msg = Buffer.alloc(8);
  let t = BigInt(Math.floor(Date.now() / 1000 / 30));
  for (let i = 7; i >= 0; i--) { msg[i] = Number(t & 0xffn); t >>= 8n; }
  const hmac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  return (((hmac[offset] & 0x7f) << 24 | hmac[offset+1] << 16 | hmac[offset+2] << 8 | hmac[offset+3]) % 1000000)
    .toString().padStart(6, '0');
}

let _angelToken = null, _angelExpiry = 0;
async function getAngelToken() {
  if (_angelToken && Date.now() < _angelExpiry) return _angelToken;
  const { ANGEL_API_KEY: apiKey, ANGEL_CLIENT_ID: clientId, ANGEL_PASSWORD: password, ANGEL_TOTP_SECRET: totpSec } = process.env;
  if (!apiKey || !clientId || !password || !totpSec) throw new Error('Angel env vars not configured');
  const totp = generateTOTP(totpSec);
  const res = await httpsPost('apiconnect.angelone.in', '/rest/auth/angelbroking/user/v1/loginByPassword',
    { clientcode: clientId, password, totp },
    { 'Content-Type':'application/json','Accept':'application/json','X-UserType':'USER','X-SourceID':'WEB',
      'X-ClientLocalIP':'127.0.0.1','X-ClientPublicIP':'127.0.0.1','X-MACAddress':'00:00:00:00:00:00','X-PrivateKey':apiKey });
  if (!res.data?.jwtToken) throw new Error(res.message || 'Angel login failed');
  _angelToken  = { jwt: res.data.jwtToken, apiKey };
  _angelExpiry = Date.now() + 22 * 60 * 60 * 1000;
  return _angelToken;
}

async function fetchFromAngel(symbol, from, to) {
  const tok = await getAngelToken();
  const hdrs = { 'Content-Type':'application/json','Accept':'application/json',
    'Authorization':'Bearer '+tok.jwt,'X-UserType':'USER','X-SourceID':'WEB',
    'X-ClientLocalIP':'127.0.0.1','X-ClientPublicIP':'127.0.0.1',
    'X-MACAddress':'00:00:00:00:00:00','X-PrivateKey':tok.apiKey };
  const search = await httpsPost('apiconnect.angelone.in',
    '/rest/secure/angelbroking/order/v1/searchScrip', { exchange:'NSE', searchscrip:symbol }, hdrs);
  const scrip = (search.data||[]).find(s => s.tradingsymbol === symbol) || (search.data||[])[0];
  if (!scrip) throw new Error('Symbol not found: ' + symbol);
  const hist = await httpsPost('apiconnect.angelone.in',
    '/rest/secure/angelbroking/historical/v1/getCandleData',
    { exchange:'NSE', symboltoken:scrip.symboltoken, interval:'ONE_DAY', fromdate:from+' 09:00', todate:to+' 15:30' }, hdrs);
  if (!hist.data?.length) throw new Error('No Angel data for ' + symbol);
  return hist.data;
}

async function fetchFromYahoo(symbol, from, to) {
  // Pass index tickers (^NSEI) and already-qualified tickers as-is
  const ticker = (symbol.startsWith('^') || symbol.includes('.')) ? symbol : symbol + '.NS';
  const fromTs = Math.floor(new Date(from).getTime() / 1000);
  const toTs   = Math.floor(new Date(to).getTime()   / 1000);
  const data   = await httpsGet(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&period1=${fromTs}&period2=${toTs}&includePrePost=false`);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error('No Yahoo data for ' + ticker);
  const ts = result.timestamp || [], q = result.indicators?.quote?.[0] || {};
  const candles = ts.map((t, i) => {
    const c = q.close?.[i]; if (c == null) return null;
    return [new Date(t*1000).toISOString(), q.open?.[i]||c, q.high?.[i]||c, q.low?.[i]||c, c, q.volume?.[i]||0];
  }).filter(Boolean);
  if (!candles.length) throw new Error('Empty Yahoo candles for ' + ticker);
  return candles;
}

// Fetch one symbol with Angel→Yahoo fallback and write to MongoDB
// Map special index symbols to their Yahoo tickers
const YAHOO_OVERRIDES = { 'NIFTY50': '^NSEI', 'SENSEX': '^BSESN' };

async function fetchAndCache(col, symbol, from, to, today) {
  let candles, source;
  // Index symbols (e.g. NIFTY50) go straight to Yahoo — no Angel lookup
  const isIndex = !!YAHOO_OVERRIDES[symbol];
  try {
    if (isIndex) throw new Error('index — skip angel');
    candles = await fetchFromAngel(symbol, from, to); source = 'angel';
  } catch {
    try {
      // For index symbols substitute the real Yahoo ticker
      const yahooSym = YAHOO_OVERRIDES[symbol] || symbol;
      candles = await fetchFromYahoo(yahooSym, from, to); source = 'yahoo';
    } catch (e) {
      throw new Error('All sources failed for ' + symbol + ': ' + e.message);
    }
  }
  const cacheKey = symbol + '_' + today;
  await col.updateOne({ _id: cacheKey },
    { $set: { symbol, date: today, candles, source, cachedAt: new Date() } },
    { upsert: true });
  return { candles, source };
}

// Run promises with limited concurrency (avoid hammering external APIs)
async function pLimit(fns, limit) {
  const results = new Array(fns.length);
  let idx = 0;
  async function worker() {
    while (idx < fns.length) {
      const i = idx++;
      try { results[i] = await fns[i](); } catch (e) { results[i] = { error: e.message }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, fns.length) }, worker));
  return results;
}

// ── Handler ────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbols: symsParam, from, to, force } = req.query;
  if (!symsParam) return res.status(400).json({ error: 'symbols required' });

  const symbols = symsParam.split(',').map(s => s.trim()).filter(Boolean);
  const today   = istDateString();
  const forceRefresh = force === '1';

  try {
    const db  = await getDb();
    const col = db.collection('candles');

    // ── Batch cache lookup ─────────────────────────────────────────────────
    const cacheKeys  = symbols.map(s => s + '_' + today);
    const cachedDocs = forceRefresh ? [] : await col.find({ _id: { $in: cacheKeys } }).toArray();
    const cachedMap  = {};
    cachedDocs.forEach(doc => { cachedMap[doc.symbol] = doc; });

    // ── Identify misses ────────────────────────────────────────────────────
    const hits   = symbols.filter(s => cachedMap[s]?.candles?.length);
    const misses = symbols.filter(s => !cachedMap[s]?.candles?.length);

    // ── Fetch misses with concurrency limit of 5 ──────────────────────────
    const fetchResults = {};
    if (misses.length) {
      const fns = misses.map(sym => () =>
        fetchAndCache(col, sym, from, to, today)
          .then(r  => { fetchResults[sym] = r; })
          .catch(e => { fetchResults[sym] = { error: e.message }; })
      );
      await pLimit(fns, 5);
    }

    // ── Build response ─────────────────────────────────────────────────────
    const results = {};
    hits.forEach(sym => {
      results[sym] = { candles: cachedMap[sym].candles, source: cachedMap[sym].source, cached: true };
    });
    misses.forEach(sym => {
      results[sym] = fetchResults[sym]
        ? { candles: fetchResults[sym].candles, source: fetchResults[sym].source, cached: false }
        : { error: fetchResults[sym]?.error || 'fetch failed' };
    });

    return res.json({ ok: true, results, date: today });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
