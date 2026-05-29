// api/cron-scan.js — Server-side cron: check paper positions, close on stop/target, alert via WhatsApp
//
// Called by Vercel Cron every minute during market hours (configured in vercel.json)
// Works entirely without a browser — reads/writes portfolio from MongoDB, prices from Yahoo
//
// Required env vars:
//   MONGODB_URI
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, TWILIO_TO
//   CRON_SECRET   — a random string you set; passed as Authorization header by Vercel

const https        = require('https');
const { MongoClient } = require('mongodb');

// ── MongoDB ────────────────────────────────────────────────────────────────
let _mongoClient = null;
async function getDb() {
  if (!_mongoClient) {
    _mongoClient = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    await _mongoClient.connect();
  }
  return _mongoClient.db('niftyscanner');
}

// ── IST helpers ────────────────────────────────────────────────────────────
function istNow() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000);
}

function isMarketOpen() {
  const t    = istNow();
  const dow  = t.getUTCDay(); // Sun=0, Sat=6
  if (dow === 0 || dow === 6) return false;
  const mins = t.getUTCHours() * 60 + t.getUTCMinutes();
  return mins >= 555 && mins <= 930; // 9:15 – 15:30 IST
}

function istTimeStr() {
  return istNow().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) + ' IST';
}

// ── Yahoo Finance price fetch ──────────────────────────────────────────────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method:   'GET',
      headers:  { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchLtps(symbols) {
  // Yahoo Finance: append .NS for NSE stocks
  const tickers = symbols.map(s => s + '.NS').join(',');
  const url = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${encodeURIComponent(tickers)}&range=1d&interval=5m`;
  try {
    const data = await httpsGet(url);
    const result = {};
    if (!data || !data.spark || !data.spark.result) return result;
    data.spark.result.forEach(r => {
      if (!r || !r.symbol) return;
      const sym  = r.symbol.replace('.NS', '');
      const resp = r.response && r.response[0];
      const pts  = resp && resp.dataPoints;
      if (pts && pts.length) {
        result[sym] = { ltp: pts[pts.length - 1].close };
      }
    });
    return result;
  } catch (e) {
    return {};
  }
}

// ── Twilio WhatsApp ────────────────────────────────────────────────────────
function sendWhatsApp(message) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const from       = process.env.TWILIO_FROM;
  const to         = process.env.TWILIO_TO;
  if (!accountSid || !authToken || !from || !to) return Promise.resolve();

  const payload = new URLSearchParams({ From: from, To: to, Body: message }).toString();
  const auth    = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.twilio.com',
      path:     `/2010-04-01/Accounts/${accountSid}/Messages.json`,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length':  Buffer.byteLength(payload),
        'Authorization':  `Basic ${auth}`
      }
    }, res => {
      res.on('data', () => {});
      res.on('end', resolve);
    });
    req.on('error', resolve); // silent — don't crash cron on Twilio failure
    req.write(payload);
    req.end();
  });
}

// ── Format helpers ─────────────────────────────────────────────────────────
function fmt(n) { return Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }

// ── Main cron handler ──────────────────────────────────────────────────────
module.exports = async (req, res) => {
  // Verify cron secret (Vercel sets Authorization: Bearer <CRON_SECRET>)
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${secret}`) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
  }

  // Skip outside market hours
  if (!isMarketOpen()) {
    return res.status(200).json({ ok: true, skipped: true, reason: 'Market closed' });
  }

  const log = [];

  try {
    const db  = await getDb();
    const col = db.collection('paper_portfolio');

    // 1. Load current portfolio
    const doc = await col.findOne({ _id: 'default' });
    if (!doc || !doc.portfolio) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'No portfolio saved yet' });
    }

    const portfolio  = doc.portfolio;
    let   positions  = portfolio.positions || [];
    const trades     = portfolio.trades    || [];
    let   cash       = portfolio.cash      || 0;
    const capital    = portfolio.capital   || 500000;

    if (!positions.length) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'No open positions' });
    }

    // 2. Fetch live prices for all open symbols
    const symbols = positions.map(p => p.sym);
    const quotes  = await fetchLtps(symbols);
    log.push(`Fetched prices for: ${symbols.join(', ')}`);

    // 3. Check each position against stop / target
    const alerts     = [];
    const closedIds  = new Set();

    for (const pos of positions) {
      const q   = quotes[pos.sym];
      const ltp = q ? q.ltp : pos.ltp || pos.entry;

      // Update LTP
      pos.ltp = ltp;

      // Stop loss check
      if (pos.stop && ltp <= +pos.stop) {
        const exitPrice = +pos.stop;
        const pnl       = (exitPrice - pos.entry) * pos.qty;
        cash += exitPrice * pos.qty;

        trades.unshift({
          id:        pos.id,
          sym:       pos.sym,
          entry:     pos.entry,
          exit:      exitPrice,
          qty:       pos.qty,
          pnl,
          reason:    'Stop Loss',
          source:    pos.source || 'cron',
          entryTime: pos.time,
          exitTime:  istTimeStr()
        });

        closedIds.add(pos.id);
        log.push(`SL hit: ${pos.sym} @ ₹${exitPrice}, P&L ₹${Math.round(pnl)}`);

        alerts.push(sendWhatsApp(
          `🛑 *Stop Loss — ${pos.sym}*\n` +
          `Entry: ₹${Math.round(pos.entry)} → Exit: ₹${Math.round(exitPrice)}\n` +
          `P&L: ${pnl >= 0 ? '+' : ''}₹${Math.round(Math.abs(pnl))} (${((exitPrice - pos.entry) / pos.entry * 100).toFixed(2)}%)\n` +
          `Qty: ${pos.qty} · Time: ${istTimeStr()}\n` +
          `*(Auto-closed by server cron)*`
        ));
        continue; // don't also check target if SL hit
      }

      // Target hit check
      if (pos.target && ltp >= +pos.target) {
        const exitPrice = +pos.target;
        const pnl       = (exitPrice - pos.entry) * pos.qty;
        cash += exitPrice * pos.qty;

        trades.unshift({
          id:        pos.id,
          sym:       pos.sym,
          entry:     pos.entry,
          exit:      exitPrice,
          qty:       pos.qty,
          pnl,
          reason:    'Target Hit',
          source:    pos.source || 'cron',
          entryTime: pos.time,
          exitTime:  istTimeStr()
        });

        closedIds.add(pos.id);
        log.push(`Target hit: ${pos.sym} @ ₹${exitPrice}, P&L ₹${Math.round(pnl)}`);

        alerts.push(sendWhatsApp(
          `🎯 *Target Hit — ${pos.sym}*\n` +
          `Entry: ₹${Math.round(pos.entry)} → Exit: ₹${Math.round(exitPrice)}\n` +
          `P&L: +₹${Math.round(Math.abs(pnl))} (+${((exitPrice - pos.entry) / pos.entry * 100).toFixed(2)}%)\n` +
          `Qty: ${pos.qty} · Time: ${istTimeStr()}\n` +
          `*(Auto-closed by server cron)*`
        ));
      }
    }

    // 4. Remove closed positions, keep updated LTPs for open ones
    positions = positions.filter(p => !closedIds.has(p.id));

    // 5. Save updated portfolio back to MongoDB
    await col.updateOne(
      { _id: 'default' },
      { $set: {
          portfolio: { ...portfolio, positions, trades, cash },
          updatedAt: new Date(),
          lastCronRun: new Date()
      }},
      { upsert: true }
    );

    // 6. Wait for all WhatsApp alerts to send
    await Promise.all(alerts);

    return res.status(200).json({
      ok: true,
      closed: closedIds.size,
      remaining: positions.length,
      log
    });

  } catch (e) {
    console.error('cron-scan error:', e);
    return res.status(200).json({ ok: false, error: e.message, log });
  }
};
