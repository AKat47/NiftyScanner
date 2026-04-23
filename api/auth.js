// api/auth.js
// Automatically logs into Zerodha using credentials + TOTP
// Called by the frontend on load — returns a valid access token
// No manual login required on any device

import crypto from 'crypto';

// ── TOTP generator (RFC 6238) ──────────────────────────
function generateTOTP(secret) {
  // Decode base32 secret
  const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const s = secret.replace(/\s/g, '').toUpperCase();
  let bits = '';
  for (let i = 0; i < s.length; i++) {
    const val = base32chars.indexOf(s[i]);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  const key = Buffer.from(bytes);

  // Time counter (30-second window)
  const counter = Math.floor(Date.now() / 1000 / 30);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigInt64BE(BigInt(counter));

  // HMAC-SHA1
  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (
    ((hmac[offset]     & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8)  |
    ((hmac[offset + 3] & 0xff))
  ) % 1000000;

  return code.toString().padStart(6, '0');
}

// ── Main handler ───────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey    = process.env.KITE_API_KEY;
  const apiSecret = process.env.KITE_API_SECRET;
  const userId    = process.env.KITE_USER_ID;
  const password  = process.env.KITE_PASSWORD;
  const totpSecret= process.env.KITE_TOTP_SECRET;

  if (!apiKey || !apiSecret || !userId || !password || !totpSecret) {
    return res.status(500).json({
      error: 'Missing environment variables. Set KITE_API_KEY, KITE_API_SECRET, KITE_USER_ID, KITE_PASSWORD, KITE_TOTP_SECRET in Vercel.'
    });
  }

  try {
    // ── Step 1: Initiate login session ──
    console.log('[auth] Step 1: initiating login...');
    const loginRes = await fetch('https://kite.trade/api/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Kite-Version': '3',
      },
      body: new URLSearchParams({ user_id: userId, password }).toString(),
    });
    const loginJson = await loginRes.json();
    console.log('[auth] login status:', loginRes.status, loginJson.status);

    if (!loginRes.ok || loginJson.status !== 'success') {
      throw new Error('Login failed: ' + (loginJson.message || loginRes.status));
    }

    const requestId = loginJson.data?.request_id;
    if (!requestId) throw new Error('No request_id in login response');

    // ── Step 2: Submit TOTP ──
    const totp = generateTOTP(totpSecret);
    console.log('[auth] Step 2: submitting TOTP:', totp);

    const totpRes = await fetch('https://kite.trade/api/twofa', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Kite-Version': '3',
      },
      body: new URLSearchParams({
        user_id:    userId,
        request_id: requestId,
        twofa_value: totp,
        twofa_type: 'totp',
        skip_session: '',
      }).toString(),
    });
    const totpJson = await totpRes.json();
    console.log('[auth] totp status:', totpRes.status, totpJson.status);

    if (!totpRes.ok || totpJson.status !== 'success') {
      throw new Error('TOTP failed: ' + (totpJson.message || totpRes.status));
    }

    const requestToken = totpJson.data?.request_token;
    if (!requestToken) throw new Error('No request_token after TOTP');

    // ── Step 3: Exchange request_token for access_token ──
    console.log('[auth] Step 3: exchanging request_token...');
    const checksum = crypto
      .createHash('sha256')
      .update(apiKey + requestToken + apiSecret)
      .digest('hex');

    const sessionRes = await fetch('https://api.kite.trade/session/token', {
      method: 'POST',
      headers: {
        'X-Kite-Version': '3',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        api_key: apiKey,
        request_token: requestToken,
        checksum,
      }).toString(),
    });
    const sessionJson = await sessionRes.json();
    console.log('[auth] session status:', sessionRes.status);

    if (!sessionRes.ok || !sessionJson.data?.access_token) {
      throw new Error('Session exchange failed: ' + (sessionJson.message || sessionRes.status));
    }

    const accessToken = sessionJson.data.access_token;
    const userName    = sessionJson.data.user_name || userId;

    console.log('[auth] ✅ token obtained for', userName);

    return res.status(200).json({
      status:       'success',
      access_token: accessToken,
      user_name:    userName,
      api_key:      apiKey,
      expires:      new Date().toDateString(),
    });

  } catch (err) {
    console.error('[auth] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
