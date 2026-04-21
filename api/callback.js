import crypto from 'crypto';

export default async function handler(req, res) {
  const { request_token, status } = req.query;
  const apiKey    = process.env.KITE_API_KEY;
  const apiSecret = process.env.KITE_API_SECRET;

  if (status !== 'success' || !request_token) {
    return res.status(400).send(errorPage('Login was cancelled or failed. <a href="/api/login">Try again</a>'));
  }

  if (!apiKey || !apiSecret) {
    return res.status(500).send(errorPage('KITE_API_KEY or KITE_API_SECRET not set in Vercel environment variables.'));
  }

  try {
    const checksum = crypto
      .createHash('sha256')
      .update(apiKey + request_token + apiSecret)
      .digest('hex');

    const r = await fetch('https://api.kite.trade/session/token', {
      method: 'POST',
      headers: {
        'X-Kite-Version': '3',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ api_key: apiKey, request_token, checksum }).toString(),
    });

    const json = await r.json();

    if (!r.ok || !json.data?.access_token) {
      throw new Error(json.message || 'Token exchange failed');
    }

    const token = json.data.access_token;
    const user  = json.data.user_name || json.data.email || 'Trader';

    res.setHeader('Content-Type', 'text/html');
    res.send(successPage(token, apiKey, user));

  } catch (err) {
    console.error('Callback error:', err.message);
    res.status(500).send(errorPage('Token exchange failed: ' + err.message + ' — <a href="/api/login">Try again</a>'));
  }
}

function successPage(token, apiKey, user) {
  return `<!DOCTYPE html><html><head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Connected!</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:monospace;background:#0b0d0c;color:#e8ede9;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;}
    .box{background:#141716;border:1px solid #252928;border-radius:16px;padding:28px 24px;max-width:400px;width:100%;text-align:center;}
    h2{color:#4ade80;font-size:20px;margin-bottom:10px;}
    p{color:#8a9b8d;font-size:13px;line-height:1.6;margin-bottom:12px;}
    .btn{display:block;background:#3dffa0;color:#050f08;padding:12px 28px;border-radius:20px;font-size:14px;font-weight:700;text-decoration:none;margin-top:16px;}
    .note{font-size:11px;color:#4d5c50;margin-top:12px;line-height:1.6;}
  </style>
  </head><body>
  <div class="box">
    <h2>✅ Connected!</h2>
    <p>Welcome ${user} — authenticated with Kite successfully.</p>
    <a class="btn" href="/">Open Scanner →</a>
    <p class="note">Token saved automatically. Expires at 6 AM IST.<br>Visit <a href="/api/login" style="color:#60a5fa">/api/login</a> each morning to refresh.</p>
  </div>
  <script>
    localStorage.setItem('kite_access_token', '${token}');
    localStorage.setItem('kite_api_key', '${apiKey}');
    localStorage.setItem('kite_token_date', new Date().toDateString());
    setTimeout(function(){ window.location.href = '/'; }, 2500);
  </script>
  </body></html>`;
}

function errorPage(msg) {
  return `<!DOCTYPE html><html><head>
  <meta charset="UTF-8">
  <title>Error</title>
  <style>
    body{font-family:monospace;background:#0b0d0c;color:#e8ede9;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;}
    .box{background:#141716;border:1px solid #2a1212;border-radius:16px;padding:28px 24px;max-width:400px;width:100%;text-align:center;}
    h2{color:#f87171;font-size:18px;margin-bottom:12px;}
    p{color:#8a9b8d;font-size:13px;line-height:1.6;}
    a{color:#60a5fa;}
  </style>
  </head><body>
  <div class="box">
    <h2>❌ Error</h2>
    <p>${msg}</p>
  </div>
  </body></html>`;
}
