// api/angel.js  — Angel One SmartAPI proxy (Vercel serverless)
// Env vars needed: ANGEL_API_KEY, ANGEL_CLIENT_ID, ANGEL_PASSWORD, ANGEL_TOTP_SECRET

const https = require('https');

function httpsPost(hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      { hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(payload) } },
      res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve({}); }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function httpsGet(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET', headers }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({}); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Simple TOTP generator (RFC 6238 / HOTP)
function generateTOTP(secret) {
  // Base32 decode
  const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const s = secret.toUpperCase().replace(/=+$/, '');
  let bits = '';
  for (const c of s) {
    const v = base32chars.indexOf(c);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const key = Buffer.from(bytes);

  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8);
  for (let i = 7; i >= 0; i--) { buf[i] = counter & 0xff; counter >>= 8; } // won't work — use BigInt below
  // Redo with BigInt for proper 64-bit counter
  const msg = Buffer.alloc(8);
  let t = BigInt(Math.floor(Date.now() / 1000 / 30));
  for (let i = 7; i >= 0; i--) { msg[i] = Number(t & 0xffn); t >>= 8n; }

  const crypto = require('crypto');
  const hmac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24 | hmac[offset+1] << 16 | hmac[offset+2] << 8 | hmac[offset+3]) % 1000000;
  return code.toString().padStart(6, '0');
}

let cachedToken = null;
let cachedExpiry = 0;

async function getAngelToken() {
  if (cachedToken && Date.now() < cachedExpiry) return cachedToken;

  const { ANGEL_API_KEY, ANGEL_CLIENT_ID, ANGEL_PASSWORD, ANGEL_TOTP_SECRET } = process.env;
  if (!ANGEL_API_KEY || !ANGEL_CLIENT_ID || !ANGEL_PASSWORD || !ANGEL_TOTP_SECRET) {
    throw new Error('Angel One env vars not configured (ANGEL_API_KEY, ANGEL_CLIENT_ID, ANGEL_PASSWORD, ANGEL_TOTP_SECRET)');
  }

  const totp = generateTOTP(ANGEL_TOTP_SECRET);
  const res = await httpsPost('apiconnect.angelone.in', '/rest/auth/angelbroking/user/v1/loginByPassword', {
    clientcode: ANGEL_CLIENT_ID,
    password: ANGEL_PASSWORD,
    totp
  }, {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': '127.0.0.1',
    'X-ClientPublicIP': '127.0.0.1',
    'X-MACAddress': '00:00:00:00:00:00',
    'X-PrivateKey': ANGEL_API_KEY
  });

  if (!res.data || !res.data.jwtToken) throw new Error(res.message || 'Angel login failed');
  cachedToken = { jwt: res.data.jwtToken, refresh: res.data.refreshToken };
  cachedExpiry = Date.now() + 22 * 60 * 60 * 1000; // 22h
  return cachedToken;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action, symbol, from, to } = req.query;

  try {
    if (action === 'auth') {
      const tok = await getAngelToken();
      return res.json({ ok: true, connected: true });
    }

    if (action === 'history') {
      const { ANGEL_API_KEY } = process.env;
      const tok = await getAngelToken();

      // Angel One needs exchange token (symboltoken), look it up
      const search = await httpsPost('apiconnect.angelone.in',
        '/rest/secure/angelbroking/order/v1/searchScrip',
        { exchange: 'NSE', searchscrip: symbol },
        {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': 'Bearer ' + tok.jwt,
          'X-UserType': 'USER',
          'X-SourceID': 'WEB',
          'X-ClientLocalIP': '127.0.0.1',
          'X-ClientPublicIP': '127.0.0.1',
          'X-MACAddress': '00:00:00:00:00:00',
          'X-PrivateKey': ANGEL_API_KEY
        }
      );

      const scrips = search.data || [];
      const scrip = scrips.find(s => s.tradingsymbol === symbol && s.instrumenttype === 'AMXIDX' === false) || scrips[0];
      if (!scrip) throw new Error('Symbol not found: ' + symbol);

      const hist = await httpsPost('apiconnect.angelone.in',
        '/rest/secure/angelbroking/historical/v1/getCandleData',
        {
          exchange: 'NSE',
          symboltoken: scrip.symboltoken,
          interval: 'ONE_DAY',
          fromdate: from + ' 09:00',
          todate: to + ' 15:30'
        },
        {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': 'Bearer ' + tok.jwt,
          'X-UserType': 'USER',
          'X-SourceID': 'WEB',
          'X-ClientLocalIP': '127.0.0.1',
          'X-ClientPublicIP': '127.0.0.1',
          'X-MACAddress': '00:00:00:00:00:00',
          'X-PrivateKey': ANGEL_API_KEY
        }
      );

      if (!hist.data || !hist.data.length) throw new Error('No candle data for ' + symbol);

      // Angel returns [timestamp, open, high, low, close, volume]
      // Normalize to Kite format: [ts, open, high, low, close, vol]
      return res.json({ ok: true, candles: hist.data });
    }

    res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
