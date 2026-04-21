export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key, X-Access-Token, X-Auth-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const accessToken = req.headers['x-access-token'];
  const authType    = req.headers['x-auth-type'] || 'enctoken';
  const apiKey      = process.env.KITE_API_KEY || req.headers['x-api-key'];

  if (!accessToken) {
    return res.status(401).json({ error: 'Missing access token.' });
  }

  // enctoken works with kite.zerodha.com/oms (internal API)
  // api_key:token works with api.kite.trade (Connect API)
  const baseUrl    = authType === 'enctoken'
    ? 'https://kite.zerodha.com/oms'
    : 'https://api.kite.trade';

  const authHeader = authType === 'enctoken'
    ? `enctoken ${accessToken}`
    : `token ${apiKey}:${accessToken}`;

  // Strip /api/kite prefix to get actual Kite path
  const withoutBase = req.url.replace(/^\/api\/kite/, '');
  const [pathOnly, ...qParts] = withoutBase.split('?');
  const queryString = qParts.length ? '?' + qParts.join('?') : '';
  const kiteUrl = `${baseUrl}${pathOnly}${queryString}`;

  console.log('[proxy]', req.method, kiteUrl);

  try {
    const opts = {
      method: req.method,
      headers: {
        'X-Kite-Version': '3',
        'Authorization':  authHeader,
        'Accept':         'application/json',
      },
    };

    if (req.method === 'POST' && req.body) {
      opts.body = new URLSearchParams(req.body).toString();
      opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    const response = await fetch(kiteUrl, opts);
    const text     = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    console.log('[proxy] status', response.status);
    res.status(response.status).json(data);
  } catch (err) {
    console.error('[proxy] error:', err.message);
    res.status(500).json({ error: err.message });
  }
}
