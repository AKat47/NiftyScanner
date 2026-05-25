// netlify/functions/auth.mjs — Kite auto-login via TOTP
// Env vars: KITE_API_KEY, KITE_API_SECRET, KITE_USER_ID, KITE_PASSWORD, KITE_TOTP_SECRET

import crypto from 'crypto';

function generateTOTP(secret) {
  const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const s = secret.toUpperCase().replace(/=+$/, '');
  let bits = '';
  for (const c of s) { const v = base32chars.indexOf(c); if (v >= 0) bits += v.toString(2).padStart(5, '0'); }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const key = Buffer.from(bytes);
  const msg = Buffer.alloc(8);
  let t = BigInt(Math.floor(Date.now() / 1000 / 30));
  for (let i = 7; i >= 0; i--) { msg[i] = Number(t & 0xffn); t >>= 8n; }
  const hmac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24 | hmac[offset+1] << 16 | hmac[offset+2] << 8 | hmac[offset+3]) % 1000000;
  return code.toString().padStart(6, '0');
}

export default async (req) => {
  const apiKey    = Netlify.env.get('KITE_API_KEY');
  const apiSecret = Netlify.env.get('KITE_API_SECRET');
  const userId    = Netlify.env.get('KITE_USER_ID');
  const password  = Netlify.env.get('KITE_PASSWORD');
  const totpSec   = Netlify.env.get('KITE_TOTP_SECRET');

  if (!apiKey || !userId || !password || !totpSec) {
    return Response.json({ error: 'Kite env vars not configured' }, { status: 500 });
  }

  try {
    // Step 1: Login
    const loginRes  = await fetch('https://kite.zerodha.com/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user_id: userId, password })
    });
    const loginData = await loginRes.json();
    if (!loginData.data?.request_id) throw new Error('Login failed: ' + (loginData.message || 'unknown'));

    // Step 2: TOTP 2FA
    const totp = generateTOTP(totpSec);
    const tfaRes  = await fetch('https://kite.zerodha.com/api/twofa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user_id: userId, request_id: loginData.data.request_id, twofa_value: totp, twofa_type: 'totp' })
    });
    const tfaData = await tfaRes.json();
    if (!tfaData.data?.enc_token) throw new Error('2FA failed: ' + (tfaData.message || 'unknown'));

    // Step 3: Get request token from Kite Connect session
    const sessRes  = await fetch(`https://api.kite.trade/session/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Kite-Version': '3' },
      body: new URLSearchParams({
        api_key: apiKey,
        request_token: tfaData.data.enc_token,
        checksum: crypto.createHash('sha256').update(apiKey + tfaData.data.enc_token + apiSecret).digest('hex')
      })
    });
    const sessData = await sessRes.json();
    if (!sessData.data?.access_token) throw new Error('Session token failed: ' + (sessData.message || 'unknown'));

    return Response.json({
      access_token: sessData.data.access_token,
      user_name: sessData.data.user_name || userId
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
};

export const config = { path: '/api/auth' };
