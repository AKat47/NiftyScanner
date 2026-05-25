// api/candles.js — Unified candle data endpoint with shared MongoDB day-cache (Vercel)
//
// Cache key : SYMBOL_YYYY-MM-DD  (IST date)
// Cache hit  : returns stored candles immediately — zero external API calls
// Cache miss : fetches Angel → Yahoo, stores result, serves all users for the day
// Force      : ?force=1 bypasses cache and overwrites the stored doc
//
// Required env vars:
//   MONGODB_URI            — MongoDB Atlas connection string
//   ANGEL_API_KEY          — Angel One SmartAPI key        (optional, Yahoo used as fallback)
//   ANGEL_CLIENT_ID        — Angel One client ID           (optional)
//   ANGEL_PASSWORD         — Angel One password            (optional)
//   ANGEL_TOTP_SECRET      — Angel One TOTP secret         (optional)

const https  = require('https');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

// ── MongoDB connection (reused across warm invocations) ────────────────────
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

// ── IST date helper ────────────────────────────────────────────────────────
function istCacheKey() {
  // Hourly cache key — format: YYYY-MM-DD-HH (IST)
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const date = ist.toISOString().split('T')[0];
  const hour = ist.getUTCHours().toString().padStart(2, '0');
  return date + '-' + hour;
}

function istDateString() {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().split('T')[0]; // YYYY-MM-DD
}

// ── Angel One helpers ──────────────────────────────────────────────────────
function httpsPost(hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      { hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(payload) } },
      res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } },
      res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function generateTOTP(secret) {
  const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const s = secret.toUpperCase().replace(/=+$/, '');
  let bits = '';
  for (const c of s) {
    const v = base32chars.indexOf(c);
    if (v >= 0) bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const key = Buffer.from(bytes);
  const msg = Buffer.alloc(8);
  let t = BigInt(Math.floor(Date.now() / 1000 / 30));
  for (let i = 7; i >= 0; i--) { msg[i] = Number(t & 0xffn); t >>= 8n; }
  const hmac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (
    (hmac[offset]     & 0x7f) << 24 |
     hmac[offset + 1]         << 16 |
     hmac[offset + 2]         <<  8 |
     hmac[offset + 3]
  ) % 1000000;
  return code.toString().padStart(6, '0');
}

let _angelToken  = null;
let _angelExpiry = 0;

async function getAngelToken() {
  if (_angelToken && Date.now() < _angelExpiry) return _angelToken;
  const { ANGEL_API_KEY, ANGEL_CLIENT_ID, ANGEL_PASSWORD, ANGEL_TOTP_SECRET } = process.env;
  if (!ANGEL_API_KEY || !ANGEL_CLIENT_ID || !ANGEL_PASSWORD || !ANGEL_TOTP_SECRET)
    throw new Error('Angel env vars not configured');
  const totp = generateTOTP(ANGEL_TOTP_SECRET);
  const res = await httpsPost('apiconnect.angelone.in',
    '/rest/auth/angelbroking/user/v1/loginByPassword',
    { clientcode: ANGEL_CLIENT_ID, password: ANGEL_PASSWORD, totp },
    { 'Content-Type': 'application/json', 'Accept': 'application/json',
      'X-UserType': 'USER', 'X-SourceID': 'WEB',
      'X-ClientLocalIP': '127.0.0.1', 'X-ClientPublicIP': '127.0.0.1',
      'X-MACAddress': '00:00:00:00:00:00', 'X-PrivateKey': ANGEL_API_KEY }
  );
  if (!res.data?.jwtToken) throw new Error(res.message || 'Angel login failed');
  _angelToken  = { jwt: res.data.jwtToken, apiKey: ANGEL_API_KEY };
  _angelExpiry = Date.now() + 22 * 60 * 60 * 1000;
  return _angelToken;
}

async function fetchFromAngel(symbol, from, to) {
  const tok  = await getAngelToken();
  const hdrs = {
    'Content-Type': 'application/json', 'Accept': 'application/json',
    'Authorization': 'Bearer ' + tok.jwt, 'X-UserType': 'USER', 'X-SourceID': 'WEB',
    'X-ClientLocalIP': '127.0.0.1', 'X-ClientPublicIP': '127.0.0.1',
    'X-MACAddress': '00:00:00:00:00:00', 'X-PrivateKey': tok.apiKey
  };
  const search = await httpsPost('apiconnect.angelone.in',
    '/rest/secure/angelbroking/order/v1/searchScrip',
    { exchange: 'NSE', searchscrip: symbol }, hdrs);
  const scrip = (search.data || []).find(s => s.tradingsymbol === symbol) || (search.data || [])[0];
  if (!scrip) throw new Error('Symbol not found in Angel: ' + symbol);
  const hist = await httpsPost('apiconnect.angelone.in',
    '/rest/secure/angelbroking/historical/v1/getCandleData',
    { exchange: 'NSE', symboltoken: scrip.symboltoken, interval: 'ONE_DAY',
      fromdate: from + ' 09:00', todate: to + ' 15:30' }, hdrs);
  if (!hist.data?.length) throw new Error('No Angel candle data for ' + symbol);
  return hist.data;
}

async function fetchFromYahoo(symbol, from, to) {
  const ticker = symbol.includes('.') ? symbol : symbol + '.NS';
  const fromTs = Math.floor(new Date(from).getTime() / 1000);
  const toTs   = Math.floor(new Date(to).getTime()   / 1000);
  const url    = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
                 `?interval=1d&period1=${fromTs}&period2=${toTs}&includePrePost=false`;
  const data   = await httpsGet(url);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error('No Yahoo data for ' + ticker);
  const ts = result.timestamp || [];
  const q  = result.indicators?.quote?.[0] || {};
  const candles = ts.map((t, i) => {
    const c = q.close?.[i];
    if (c == null) return null;
    return [new Date(t * 1000).toISOString(), q.open?.[i] || c, q.high?.[i] || c, q.low?.[i] || c, c, q.volume?.[i] || 0];
  }).filter(Boolean);
  if (!candles.length) throw new Error('Empty Yahoo candles for ' + ticker);
  return candles;
}

// ── Handler ────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, from, to, force } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  const today    = istDateString();
  const cacheKey = symbol + '_' + istCacheKey(); // hourly key

  try {
    const db  = await getDb();
    const col = db.collection('candles');

    // ── Cache hit (hourly) ─────────────────────────────────────────────────
    if (force !== '1') {
      const cached = await col.findOne({ _id: cacheKey });
      if (cached?.candles?.length) {
        return res.json({ ok: true, candles: cached.candles, source: cached.source, cached: true });
      }
    }

    // ── Cache miss: fetch Angel → Yahoo ────────────────────────────────────
    let candles, source;
    try {
      candles = await fetchFromAngel(symbol, from, to);
      source  = 'angel';
    } catch (e1) {
      console.warn('Angel failed for', symbol, e1.message, '— trying Yahoo');
      try {
        candles = await fetchFromYahoo(symbol, from, to);
        source  = 'yahoo';
      } catch (e2) {
        throw new Error('All sources failed for ' + symbol + ': ' + e2.message);
      }
    }

    // ── Store in MongoDB (hourly key) ──────────────────────────────────────
    await col.updateOne(
      { _id: cacheKey },
      { $set: { symbol, date: today, candles, source, cachedAt: new Date() } },
      { upsert: true }
    );

    return res.json({ ok: true, candles, source, cached: false });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
