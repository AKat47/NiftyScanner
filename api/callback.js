import crypto from 'crypto';

export default async function handler(req, res) {
  const { request_token, status } = req.query;

  if (status !== 'success' || !request_token) {
    return res.status(400).send(page('Login Failed', '#f87171', 'Login was cancelled or failed.', '', false));
  }

  const apiKey    = process.env.KITE_API_KEY;
  const apiSecret = process.env.KITE_API_SECRET;

  if (!apiKey || !apiSecret) {
    return res.status(500).send(page('Config Error', '#f87171', 'KITE_API_KEY or KITE_API_SECRET not set in Vercel.', '', false));
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
    res.send(page('Connected!', '#4ade80', `Welcome ${user} — you are now connected to Kite.`, token, true));

  } catch (err) {
    res.status(500).send(page('Error', '#f87171', err.message, '', false));
  }
}

function page(title, color, msg, token, success) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:monospace;background:#0b0d0c;color:#e8ede9;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;}
    .box{background:#141716;border:1px solid #252928;border-radius:16px;padding:28px 24px;max-width:420px;width:100%;text-align:center;}
    h2{color:${color};font-size:20px;margin-bottom:12px;}
    p{color:#8a9b8d;font-size:13px;line-height:1.6;margin-bottom:16px;}
    .token{background:#252928;padding:10px;border-radius:8px;font-size:10px;word-break:break-all;color:#fbbf24;margin:12px 0;text-align:left;}
    .btn{display:inline-block;background:#3dffa0;color:#050f08;padding:11px 28px;border-radius:20px;font-size:14px;font-weight:700;text-decoration:none;cursor:pointer;border:none;font-family:monospace;width:100%;margin-top:4px;}
    .note{font-size:11px;color:#4d5c50;margin-top:12px;line-height:1.6;}
  </style>
  </head><body><div class="box">
    <h2>${success ? '✅' : '❌'} ${title}</h2>
    <p>${msg}</p>
    ${success ? `
      <div class="token" id="tok">${token}</div>
      <a class="btn" href="/">Open Scanner →</a>
      <p class="note">Token saved automatically. Valid until 6 AM IST tomorrow.<br>Visit <a href="/api/login" style="color:#60a5fa">/api/login</a> each morning to refresh.</p>
    ` : `<a class="btn" href="/api/login">Try Again</a>`}
  </div>
  ${success ? `<script>
    localStorage.setItem('kite_access_token', '${token}');
    localStorage.setItem('kite_api_key', '${apiKey}');
    localStorage.setItem('kite_token_date', new Date().toDateString());
    localStorage.setItem('kite_auth_type', 'token');
    setTimeout(function(){ window.location.href = '/'; }, 3000);
  </script>` : ''}
  </body></html>`;
}
