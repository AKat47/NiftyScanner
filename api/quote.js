// api/quote.js — Live market quotes for day trading
//
// Uses Yahoo Finance v8/finance/chart (same endpoint as scan.js — works without crumb)
// Each symbol is fetched in parallel with a small concurrency limit.
//
// Primary:  Kite Connect /quote  (if kiteToken provided)
// Fallback: Yahoo Finance chart  (15-min delay, no auth required)
//
// Query params:
//   symbols   — comma-separated NSE symbols, e.g. NIFTY50,TCS,RELIANCE
//   kiteToken — "apiKey:accessToken" string from Kite Connect  (optional)
//
// Response per symbol:
//   { ltp, open, high, low, pdc, volume, change, source }

const https = require('https');

const YAHOO_OVERRIDE = { 'NIFTY50': '^NSEI', 'SENSEX': '^BSESN' };
const CONCURRENCY = 8;

// ── HTTP helper ────────────────────────────────────────────────────────────────
function httpsGet(url, extraHeaders) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'application/json',
          ...(extraHeaders || {})
        }
      },
      res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// ── Concurrency-limited batch fetch ───────────────────────────────────────────
async function withConcurrency(items, fn, limit) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try { results[i] = await fn(items[i], i); }
      catch { results[i] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ── Yahoo Finance — per-symbol chart endpoint (no crumb needed) ───────────────
async function fetchYahooQuoteOne(symbol) {
  const ticker = YAHOO_OVERRIDE[symbol] || (symbol + '.NS');
  // range=5d gives us the last 5 trading days — enough to get today + prev close
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d&includePrePost=false`;
  const data = await httpsGet(url);

  const result = data?.chart?.result?.[0];
  if (!result) return null;

  const meta   = result.meta || {};
  const q      = result.indicators?.quote?.[0] || {};
  const ts     = result.timestamp || [];

  if (!ts.length) return null;

  const last = ts.length - 1;
  const prev = last > 0 ? last - 1 : null;

  // ltp: prefer meta.regularMarketPrice (real-time), fall back to last close
  const ltp = meta.regularMarketPrice ?? q.close?.[last];
  if (ltp == null) return null;

  // pdc: previous day close from candle data, or meta fallback
  const pdc = prev !== null
    ? (q.close?.[prev] ?? meta.chartPreviousClose ?? meta.previousClose)
    : (meta.chartPreviousClose ?? meta.previousClose);

  const changeVal = pdc ? ((ltp - pdc) / pdc) * 100 : (meta.regularMarketChangePercent ?? 0);

  return {
    ltp,
    open:   q.open?.[last]   ?? meta.regularMarketOpen,
    high:   q.high?.[last]   ?? meta.regularMarketDayHigh,
    low:    q.low?.[last]    ?? meta.regularMarketDayLow,
    pdc,
    volume: q.volume?.[last] ?? meta.regularMarketVolume,
    change: changeVal,
    source: 'yahoo'
  };
}

async function fetchYahooQuotes(symbols) {
  const quotes = await withConcurrency(symbols, fetchYahooQuoteOne, CONCURRENCY);
  const result = {};
  symbols.forEach((sym, i) => { if (quotes[i]) result[sym] = quotes[i]; });
  return result;
}

// ── Kite Connect quote ─────────────────────────────────────────────────────────
async function fetchKiteQuotes(symbols, kiteToken) {
  const qs = symbols.map(s => 'i=NSE:' + s).join('&');
  const data = await httpsGet(
    `https://api.kite.trade/quote?${qs}`,
    { 'X-Kite-Version': '3', 'Authorization': 'token ' + kiteToken }
  );
  if (!data.data) throw new Error('Kite: ' + (data.message || 'quote failed'));
  const result = {};
  symbols.forEach(sym => {
    const q = data.data['NSE:' + sym];
    if (!q) return;
    result[sym] = {
      ltp:    q.last_price,
      open:   q.ohlc?.open,
      high:   q.ohlc?.high,
      low:    q.ohlc?.low,
      pdc:    q.ohlc?.close,
      volume: q.volume,
      change: q.change,
      source: 'kite'
    };
  });
  return result;
}

// ── Handler ────────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbols: symsParam, kiteToken } = req.query;
  if (!symsParam) return res.status(400).json({ error: 'symbols required' });
  const symbols = symsParam.split(',').map(s => s.trim()).filter(Boolean);

  try {
    let quotes;
    if (kiteToken) {
      try {
        quotes = await fetchKiteQuotes(symbols, kiteToken);
        const missed = symbols.filter(s => !quotes[s]);
        if (missed.length) Object.assign(quotes, await fetchYahooQuotes(missed));
      } catch (e) {
        console.warn('Kite quote failed, using Yahoo:', e.message);
        quotes = await fetchYahooQuotes(symbols);
      }
    } else {
      quotes = await fetchYahooQuotes(symbols);
    }
    return res.json({ ok: true, quotes });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
