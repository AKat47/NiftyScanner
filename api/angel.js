// api/angel.js  — Angel One SmartAPI proxy (Vercel serverless)
// Env vars: ANGEL_API_KEY, ANGEL_CLIENT_ID, ANGEL_PASSWORD, ANGEL_TOTP_SECRET

const https  = require('https');
const crypto = require('crypto');

// ── HTTP helpers ───────────────────────────────────────────
function httpsPost(hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      { hostname, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json',
                   ...headers, 'Content-Length': Buffer.byteLength(payload) } },
      res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function httpsGetRaw(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0' } },
      res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// ── TOTP (matches Python pyotp exactly) ───────────────────
function b32decode(secret) {
  const base32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.trim().toUpperCase().replace(/=+$/, '')) {
    const v = base32.indexOf(c);
    if (v >= 0) bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8)
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totpCode(key, counter) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac   = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code   = ((hmac[offset] & 0x7f) << 24 | hmac[offset+1] << 16
                | hmac[offset+2] << 8   | hmac[offset+3]) % 1000000;
  return code.toString().padStart(6, '0');
}

// ── Instruments master (token lookup) ─────────────────────
let _tokenMap  = null;

async function getTokenMap() {
  if (_tokenMap) return _tokenMap;
  const data = await httpsGetRaw(
    'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json'
  );
  const map = {};
  if (Array.isArray(data)) {
    for (const inst of data) {
      if (inst.exch_seg !== 'NSE' || !inst.token) continue;
      // "RELIANCE-EQ" → token "2885"
      const full   = (inst.symbol || '').trim().toUpperCase();
      const ticker = full.replace(/-EQ$/i, '');
      if (ticker) map[ticker] = inst.token;
      if (full)   map[full]   = inst.token;
    }
  }
  _tokenMap = map;
  return map;
}

async function resolveToken(symbol) {
  const map = await getTokenMap();
  return map[symbol.toUpperCase()]
      || map[symbol.toUpperCase() + '-EQ']
      || null;
}

// ── Angel One JWT (cached, ±1 TOTP window retry) ──────────
let _jwtCache   = null;
let _jwtExpiry  = 0;

async function getJwt() {
  if (_jwtCache && Date.now() < _jwtExpiry) return _jwtCache;

  const { ANGEL_API_KEY: apiKey, ANGEL_CLIENT_ID: clientId,
          ANGEL_PASSWORD: password, ANGEL_TOTP_SECRET: totpSecret } = process.env;

  if (!apiKey)    throw new Error('ANGEL_API_KEY env var not set');
  if (!clientId)  throw new Error('ANGEL_CLIENT_ID env var not set');
  if (!password)  throw new Error('ANGEL_PASSWORD env var not set');
  if (!totpSecret)throw new Error('ANGEL_TOTP_SECRET env var not set');

  const key     = b32decode(totpSecret);
  const counter = Math.floor(Date.now() / 1000 / 30);
  const headers = {
    'X-UserType': 'USER', 'X-SourceID': 'WEB',
    'X-ClientLocalIP': '127.0.0.1', 'X-ClientPublicIP': '127.0.0.1',
    'X-MACAddress': '00:00:00:00:00:00', 'X-PrivateKey': apiKey
  };

  let lastBody;
  for (const delta of [0, 1, -1]) {
    const otp  = totpCode(key, counter + delta);
    const body = await httpsPost('apiconnect.angelbroking.com',
      '/rest/auth/angelbroking/user/v1/loginByPassword',
      { clientcode: clientId, password, totp: otp }, headers);
    lastBody = body;
    if (body?.data?.jwtToken) {
      _jwtCache  = { jwt: body.data.jwtToken, refresh: body.data.refreshToken };
      _jwtExpiry = Date.now() + 22 * 60 * 60 * 1000;
      return _jwtCache;
    }
    const msg = (body?.message || '').toLowerCase();
    if (!msg.includes('totp') && !msg.includes('otp')) break; // non-TOTP error, don't retry
  }

  const errMsg  = lastBody?.message  || 'Login failed';
  const errCode = lastBody?.errorcode || '';
  throw new Error(`${errMsg}${errCode ? ' (' + errCode + ')' : ''} — Full: ${JSON.stringify(lastBody)}`);
}

// ── Main handler ───────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action, symbol, from, to } = req.query;
  const { ANGEL_API_KEY: apiKey } = process.env;

  try {
    // ── auth: test connection ──────────────────────────────
    if (action === 'auth') {
      await getJwt();
      return res.json({ ok: true, connected: true });
    }

    // ── history: fetch daily candles ───────────────────────
    if (action === 'history') {
      const tok   = await getJwt();
      const token = await resolveToken(symbol);
      if (!token) throw new Error(`Symbol "${symbol}" not found in Angel One instruments master. Use exact NSE ticker e.g. RELIANCE`);

      const hist = await httpsPost('apiconnect.angelbroking.com',
        '/rest/secure/angelbroking/historical/v1/getCandleData',
        { exchange: 'NSE', symboltoken: token,
          interval: 'ONE_DAY',
          fromdate: from + ' 09:00',
          todate:   to   + ' 15:30' },
        { 'Authorization': 'Bearer ' + tok.jwt,
          'X-UserType': 'USER', 'X-SourceID': 'WEB',
          'X-ClientLocalIP': '127.0.0.1', 'X-ClientPublicIP': '127.0.0.1',
          'X-MACAddress': '00:00:00:00:00:00', 'X-PrivateKey': apiKey }
      );

      if (!hist.data?.length) {
        throw new Error(`No candle data for ${symbol} — Angel One response: ${JSON.stringify(hist)}`);
      }
      // Angel returns [timestamp, open, high, low, close, volume]
      return res.json({ ok: true, candles: hist.data });
    }

    return res.status(400).json({ error: 'Unknown action. Use ?action=auth or ?action=history' });

  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message });
  }
};
