// api/proxy.js — Kite Connect API reverse proxy
//
// All requests to /api/kite/:path* are rewritten here by vercel.json.
// This proxy strips the /api/kite prefix, forwards the request to
// https://api.kite.trade with the Kite auth headers, and returns the response.
//
// The client must supply one of:
//   - Header:      X-Access-Token: "apiKey:accessToken"
//   - Query param: kiteToken=apiKey:accessToken
//
// Example: GET /api/kite/quote?i=NSE:RELIANCE
//   → GET https://api.kite.trade/quote?i=NSE:RELIANCE

const https = require('https');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Resolve the upstream Kite path by stripping /api/kite prefix
  const rawUrl = req.url || '/';
  const kitePath = rawUrl.replace(/^\/api\/kite/, '') || '/';

  // Resolve access token: header first, then query param
  const headerToken = req.headers['x-access-token'];
  const queryToken  = req.query && req.query.kiteToken;
  const token       = headerToken || queryToken;

  if (!token) {
    return res.status(401).json({ error: 'Missing Kite token. Provide X-Access-Token header or kiteToken query param.' });
  }

  const upstreamUrl = 'https://api.kite.trade' + kitePath;

  try {
    const data = await new Promise((resolve, reject) => {
      const u = new URL(upstreamUrl);
      const options = {
        hostname: u.hostname,
        path:     u.pathname + u.search,
        method:   req.method || 'GET',
        headers: {
          'X-Kite-Version': '3',
          'Authorization':  'token ' + token,
          'User-Agent':     'NiftyScanner/1.0',
          'Accept':         'application/json',
          'Content-Type':   'application/json'
        }
      };

      const proxyReq = https.request(options, proxyRes => {
        let body = '';
        proxyRes.on('data', chunk => body += chunk);
        proxyRes.on('end', () => {
          try {
            resolve({ status: proxyRes.statusCode, body: JSON.parse(body) });
          } catch {
            resolve({ status: proxyRes.statusCode, body: body });
          }
        });
      });

      proxyReq.on('error', reject);

      // Forward request body for POST/PUT
      if (req.method === 'POST' || req.method === 'PUT') {
        if (req.body) proxyReq.write(JSON.stringify(req.body));
      }

      proxyReq.end();
    });

    return res.status(data.status).json(data.body);
  } catch (e) {
    return res.status(502).json({ error: 'Kite proxy error: ' + e.message });
  }
};
