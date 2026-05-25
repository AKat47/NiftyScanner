// netlify/functions/kite.mjs — Zerodha Kite API proxy
// Env vars: KITE_API_KEY (set via Netlify UI)

export default async (req) => {
  const url   = new URL(req.url);
  // strip /api/kite prefix to get the downstream Kite path
  const kitePath = url.pathname.replace(/^\/api\/kite/, '') + url.search;
  const token = req.headers.get('X-Access-Token') || '';

  const kiteUrl = 'https://api.kite.trade' + kitePath;
  try {
    const res  = await fetch(kiteUrl, {
      headers: {
        'X-Kite-Version': '3',
        'Authorization': 'token ' + (Netlify.env.get('KITE_API_KEY') || '') + ':' + token
      }
    });
    const data = await res.json();
    return Response.json(data, { status: res.status });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
};

export const config = { path: '/api/kite/*' };
