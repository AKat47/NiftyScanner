// api/intraday.js — 15-minute intraday candles for ORB strategy
//
// Returns the opening range (first 15-min candle) + all candles for the day
// so the client can compute ORB signals and render a mini chart.
//
// Query params:
//   symbols — comma-separated NSE symbols, e.g. NIFTY50,TCS,RELIANCE
//
// Response per symbol:
//   { orbH, orbL, orbSize, ltp, change, candles, volRatio, avgVol }
//   candles: [{ t, o, h, l, c, v }]  (15-min bars, epoch seconds)

const https = require('https');
const CONCURRENCY = 6;
const OVERRIDES = { 'NIFTY50': '^NSEI', 'SENSEX': '^BSESN' };

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json'
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.end();
  });
}

async function withConcurrency(items, fn, limit) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try { results[i] = await fn(items[i]); }
      catch { results[i] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function fetchIntradayOne(symbol) {
  const ticker = OVERRIDES[symbol] || (symbol + '.NS');
  // range=1d with interval=15m gives all 15-min bars for the latest trading session
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=15m&range=1d&includePrePost=false`;
  const data = await httpsGet(url);

  const result = data?.chart?.result?.[0];
  if (!result) return null;

  const meta = result.meta || {};
  const ts   = result.timestamp || [];
  const q    = result.indicators?.quote?.[0] || {};

  // Build clean candle list (filter nulls — Yahoo sometimes has gaps)
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i];
    if (o == null) continue;
    candles.push({
      t: ts[i],
      o,
      h: q.high?.[i]   ?? o,
      l: q.low?.[i]    ?? o,
      c: q.close?.[i]  ?? o,
      v: q.volume?.[i] ?? 0
    });
  }

  if (candles.length < 1) return null;

  // Opening Range = first candle (9:15–9:30 IST)
  const orb  = candles[0];
  const orbH = orb.h;
  const orbL = orb.l;

  // Current price — real-time meta price if available
  const ltp = meta.regularMarketPrice ?? candles[candles.length - 1].c;

  // Average intraday volume (skip first candle — opening surge distorts)
  const bodyCandles = candles.slice(1);
  const avgVol = bodyCandles.length
    ? bodyCandles.reduce((s, c) => s + c.v, 0) / bodyCandles.length
    : candles[0].v;

  const latestVol = candles[candles.length - 1].v;
  const volRatio  = avgVol > 0 ? latestVol / avgVol : 1;

  return {
    orbH,
    orbL,
    orbSize: +(orbH - orbL).toFixed(2),
    ltp,
    change: meta.regularMarketChangePercent ?? 0,
    candles,
    volRatio: +volRatio.toFixed(2),
    avgVol: Math.round(avgVol)
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbols: symsParam } = req.query;
  if (!symsParam) return res.status(400).json({ error: 'symbols required' });
  const symbols = symsParam.split(',').map(s => s.trim()).filter(Boolean);

  const raw = await withConcurrency(symbols, fetchIntradayOne, CONCURRENCY);
  const data = {};
  symbols.forEach((sym, i) => { if (raw[i]) data[sym] = raw[i]; });

  return res.json({ ok: true, data });
};
