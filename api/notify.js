// api/notify.js  — Twilio WhatsApp notification proxy (Vercel serverless)
// Env vars needed: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, TWILIO_TO
//
// TWILIO_FROM  — your Twilio WhatsApp sender  e.g. whatsapp:+14155238886
// TWILIO_TO    — your personal WhatsApp number e.g. whatsapp:+919876543210

const https = require('https');

function twilioPost(accountSid, authToken, body) {
  const payload = new URLSearchParams(body).toString();
  const auth    = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.twilio.com',
      path:     `/2010-04-01/Accounts/${accountSid}/Messages.json`,
      method:   'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length':  Buffer.byteLength(payload),
        'Authorization':  `Basic ${auth}`
      }
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = async (req, res) => {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // Read env vars (set in Vercel dashboard)
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM; // e.g. whatsapp:+14155238886
  const toNumber   = process.env.TWILIO_TO;   // e.g. whatsapp:+919876543210

  if (!accountSid || !authToken || !fromNumber || !toNumber) {
    return res.status(200).json({ ok: false, error: 'Twilio env vars not configured' });
  }

  // Parse body
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
  }

  const { message } = body;
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ ok: false, error: 'Missing message field' });
  }

  try {
    const result = await twilioPost(accountSid, authToken, {
      From: fromNumber,
      To:   toNumber,
      Body: message
    });

    if (result.status >= 200 && result.status < 300) {
      return res.status(200).json({ ok: true, sid: result.body.sid });
    } else {
      const errMsg = result.body?.message || result.body?.error_message || JSON.stringify(result.body);
      return res.status(200).json({ ok: false, error: errMsg });
    }
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message });
  }
};
