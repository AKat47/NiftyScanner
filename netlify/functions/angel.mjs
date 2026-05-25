// netlify/functions/angel.mjs — Angel One SmartAPI proxy
// Env vars: ANGEL_API_KEY, ANGEL_CLIENT_ID, ANGEL_PASSWORD, ANGEL_TOTP_SECRET

import https from 'https';
import crypto from 'crypto';

function httpsPost(hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      { hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(payload) } },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } }); }
    );
    req.on('error', reject); req.write(payload); req.end();
  });
}

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

let cachedToken = null;
let cachedExpiry = 0;

async function getAngelToken() {
  if (cachedToken && Date.now() < cachedExpiry) return cachedToken;
  const apiKey   = Netlify.env.get('ANGEL_API_KEY');
  const clientId = Netlify.env.get('ANGEL_CLIENT_ID');
  const password = Netlify.env.get('ANGEL_PASSWORD');
  const totpSec  = Netlify.env.get('ANGEL_TOTP_SECRET');
  if (!apiKey || !clientId || !password || !totpSec)
    throw new Error('Angel One env vars not configured');
  const totp = generateTOTP(totpSec);
  const res = await httpsPost('apiconnect.angelone.in', '/rest/auth/angelbroking/user/v1/loginByPassword',
    { clientcode: clientId, password, totp },
    { 'Content-Type':'application/json','Accept':'application/json','X-UserType':'USER',
      'X-SourceID':'WEB','X-ClientLocalIP':'127.0.0.1','X-ClientPublicIP':'127.0.0.1',
      'X-MACAddress':'00:00:00:00:00:00','X-PrivateKey': apiKey }
  );
  if (!res.data?.jwtToken) throw new Error(res.message || 'Angel login failed');
  cachedToken  = { jwt: res.data.jwtToken };
  cachedExpiry = Date.now() + 22 * 60 * 60 * 1000;
  return cachedToken;
}

export default async (req) => {
  const url    = new URL(req.url);
  const action = url.searchParams.get('action');
  const symbol = url.searchParams.get('symbol');
  const from   = url.searchParams.get('from');
  const to     = url.searchParams.get('to');

  try {
    if (action === 'auth') {
      await getAngelToken();
      return Response.json({ ok: true, connected: true });
    }

    if (action === 'history') {
      const apiKey = Netlify.env.get('ANGEL_API_KEY');
      const tok    = await getAngelToken();
      const hdrs   = { 'Content-Type':'application/json','Accept':'application/json',
        'Authorization':'Bearer '+tok.jwt,'X-UserType':'USER','X-SourceID':'WEB',
        'X-ClientLocalIP':'127.0.0.1','X-ClientPublicIP':'127.0.0.1',
        'X-MACAddress':'00:00:00:00:00:00','X-PrivateKey': apiKey };

      const search = await httpsPost('apiconnect.angelone.in',
        '/rest/secure/angelbroking/order/v1/searchScrip',
        { exchange: 'NSE', searchscrip: symbol }, hdrs);
      const scrips = search.data || [];
      const scrip  = scrips.find(s => s.tradingsymbol === symbol) || scrips[0];
      if (!scrip) throw new Error('Symbol not found: ' + symbol);

      const hist = await httpsPost('apiconnect.angelone.in',
        '/rest/secure/angelbroking/historical/v1/getCandleData',
        { exchange:'NSE', symboltoken: scrip.symboltoken, interval:'ONE_DAY',
          fromdate: from+' 09:00', todate: to+' 15:30' }, hdrs);
      if (!hist.data?.length) throw new Error('No candle data for ' + symbol);
      return Response.json({ ok: true, candles: hist.data });
    }

    return Response.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
};

export const config = { path: '/api/angel' };
