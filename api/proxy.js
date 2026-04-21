export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key, X-Access-Token, X-Auth-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const accessToken = req.headers['x-access-token'];
  const apiKey      = process.env.KITE_API_KEY;

  if (!accessToken) {
    return res.status(401).json({ error: 'Not authenticated. Visit /api/login' });
  }

  // Strip /api/kite prefix → get actual Kite path + query
  const withoutBase = req.url.replace(/^\/api\/kite/, '');
  const [pathOnly, ...qParts] = withoutBase.split('?');
  const rawQuery    = qParts.join('?');

  // Rebuild repeated i= params correctly (Vercel may collapse them)
  const urlParams   = new URLSearchParams(rawQuery);
  const instruments = urlParams.getAll('i');
  const finalQuery  = instruments.length
    ? instruments.map(v => 'i=' + encodeURIComponent(v)).join('&')
    : rawQuery;

  const kiteUrl = `https://api.kite.trade${pathOnly}${finalQuery ? '?' + finalQuery : ''}`;

  console.log('[proxy]', req.method, kiteUrl);

  try {
    const opts = {
      method: req.method,
      headers: {
        'X-Kite-Version': '3',
        'Authorization':  `token ${apiKey}:${accessToken}`,
        'Accept':         'application/json',
      },
    };

    if (req.method === 'POST' && req.body) {
      opts.body = new URLSearchParams(req.body).toString();
      opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    const response = await fetch(kiteUrl, opts);
    const text     = await response.text();
    console.log('[proxy]', response.status, text.substring(0, 200));

    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    res.status(response.status).json(data);
  } catch (err) {
    console.error('[proxy] error:', err.message);
    res.status(500).json({ error: err.message });
  }
}
