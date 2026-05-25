// api/yahoo.js  — Yahoo Finance proxy (Vercel serverless)
// No credentials needed — uses public Yahoo Finance v8 chart API

const https = require('https');

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json'
      }
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({}); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, from, to } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  // Yahoo uses SYMBOL.NS for NSE stocks
  const ticker = symbol.includes('.') ? symbol : symbol + '.NS';
  const fromTs = from ? Math.floor(new Date(from).getTime() / 1000) : Math.floor(Date.now() / 1000) - 400 * 86400;
  const toTs = to ? Math.floor(new Date(to).getTime() / 1000) : Math.floor(Date.now() / 1000);

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&period1=${fromTs}&period2=${toTs}&includePrePost=false`;

  try {
    const data = await httpsGet(url);
    const result = data?.chart?.result?.[0];
    if (!result) throw new Error('No data from Yahoo for ' + ticker);

    const ts = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    const opens = q.open || [];
    const highs = q.high || [];
    const lows = q.low || [];
    const closes = q.close || [];
    const vols = q.volume || [];

    // Normalize to same candle format as Kite/Angel: [ts, open, high, low, close, volume]
    const candles = ts.map((t, i) => {
      const c = closes[i];
      if (c == null) return null;
      return [
        new Date(t * 1000).toISOString(),
        opens[i] || c,
        highs[i] || c,
        lows[i] || c,
        c,
        vols[i] || 0
      ];
    }).filter(Boolean);

    if (!candles.length) throw new Error('Empty candle data from Yahoo for ' + ticker);

    res.json({ ok: true, candles, ticker });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
