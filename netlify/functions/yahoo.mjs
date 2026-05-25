// netlify/functions/yahoo.mjs — Yahoo Finance proxy (no auth needed)

export default async (req) => {
  const url    = new URL(req.url);
  const symbol = url.searchParams.get('symbol');
  const from   = url.searchParams.get('from');
  const to     = url.searchParams.get('to');

  if (!symbol) return Response.json({ error: 'symbol required' }, { status: 400 });

  const ticker  = symbol.includes('.') ? symbol : symbol + '.NS';
  const fromTs  = from ? Math.floor(new Date(from).getTime() / 1000) : Math.floor(Date.now() / 1000) - 400 * 86400;
  const toTs    = to   ? Math.floor(new Date(to).getTime()   / 1000) : Math.floor(Date.now() / 1000);
  const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&period1=${fromTs}&period2=${toTs}&includePrePost=false`;

  try {
    const res  = await fetch(yahooUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) throw new Error('No data from Yahoo for ' + ticker);

    const ts     = result.timestamp || [];
    const q      = result.indicators?.quote?.[0] || {};
    const candles = ts.map((t, i) => {
      const c = q.close?.[i]; if (c == null) return null;
      return [ new Date(t * 1000).toISOString(), q.open?.[i]||c, q.high?.[i]||c, q.low?.[i]||c, c, q.volume?.[i]||0 ];
    }).filter(Boolean);

    if (!candles.length) throw new Error('Empty candle data from Yahoo for ' + ticker);
    return Response.json({ ok: true, candles, ticker });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
};

export const config = { path: '/api/yahoo' };
