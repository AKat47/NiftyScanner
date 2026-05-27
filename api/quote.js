// api/quote.js — Live market quotes for day trading
//
// Primary:  Kite Connect /quote  (if kiteToken provided in query)
// Fallback: Yahoo Finance v7/finance/quote  (15-min delay, no auth)
//
// Query params:
//   symbols   — comma-separated NSE symbols, e.g. NIFTY50,TCS,RELIANCE
//   kiteToken — "apiKey:accessToken" string from Kite Connect  (optional)
//
// Response per symbol:
//   { ltp, open, high, low, pdc, volume, change, source }
//   pdc = previous day close (used to compute gap %)

const https = require('https');

const YAHOO_OVERRIDE = { 'NIFTY50': '^NSEI', 'SENSEX': '^BSESN' };

function httpsGet(url, extraHeaders) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', ...(extraHeaders||{}) } },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } }); }
    );
    req.on('error', reject); req.end();
  });
}

// ── Kite Connect quote ──────────────────────────────────────────────────────
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
      pdc:    q.ohlc?.close,   // Kite ohlc.close = previous day close
      volume: q.volume,
      change: q.change,        // % change from previous close
      source: 'kite'
    };
  });
  return result;
}

// ── Yahoo Finance quote (fallback) ──────────────────────────────────────────
async function fetchYahooQuotes(symbols) {
  // Map NSE symbols to Yahoo tickers
  const tickerToSym = {};
  const tickers = symbols.map(s => {
    const t = YAHOO_OVERRIDE[s] || (s + '.NS');
    tickerToSym[t] = s;
    return t;
  });

  const fields = [
    'regularMarketPrice','regularMarketOpen','regularMarketDayHigh',
    'regularMarketDayLow','regularMarketPreviousClose',
    'regularMarketVolume','regularMarketChangePercent'
  ].join(',');

  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(tickers.join(','))}&fields=${fields}`;
  const data = await httpsGet(url);
  const quotes = data?.quoteResponse?.result || [];

  const result = {};
  quotes.forEach(q => {
    const sym = tickerToSym[q.symbol];
    if (!sym) return;
    result[sym] = {
      ltp:    q.regularMarketPrice,
      open:   q.regularMarketOpen,
      high:   q.regularMarketDayHigh,
      low:    q.regularMarketDayLow,
      pdc:    q.regularMarketPreviousClose,
      volume: q.regularMarketVolume,
      change: q.regularMarketChangePercent,
      source: 'yahoo'
    };
  });
  return result;
}

// ── Handler ────────────────────────────────────────────────────────────────
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
        // For any symbols Kite missed, fall back to Yahoo
        const missed = symbols.filter(s => !quotes[s]);
        if (missed.length) {
          const yq = await fetchYahooQuotes(missed);
          Object.assign(quotes, yq);
        }
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
