// api/portfolio.js — Persist paper trading portfolio to MongoDB
// GET  /api/portfolio          → returns saved portfolio
// POST /api/portfolio          → saves portfolio (body: { positions, trades, cash, capital })
//
// Required env vars: MONGODB_URI

const { MongoClient } = require('mongodb');

let _mongoClient = null;
async function getDb() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI env var not set');
  if (!_mongoClient) {
    _mongoClient = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
    await _mongoClient.connect();
  }
  return _mongoClient.db('niftyscanner');
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const db  = await getDb();
    const col = db.collection('paper_portfolio');

    // ── GET: return current portfolio ──────────────────────────────────────
    if (req.method === 'GET') {
      const doc = await col.findOne({ _id: 'default' });
      if (!doc) {
        return res.status(200).json({ ok: true, portfolio: null }); // first time
      }
      return res.status(200).json({ ok: true, portfolio: doc.portfolio });
    }

    // ── POST: save portfolio ───────────────────────────────────────────────
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { positions, trades, cash, capital, autoTrade, scannerAuto } = body;

      await col.updateOne(
        { _id: 'default' },
        { $set: {
            portfolio: { positions, trades, cash, capital, autoTrade, scannerAuto },
            updatedAt: new Date()
        }},
        { upsert: true }
      );
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });

  } catch (e) {
    console.error('portfolio error:', e);
    return res.status(200).json({ ok: false, error: e.message });
  }
};
