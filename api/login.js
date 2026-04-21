export default function handler(req, res) {
  const apiKey = process.env.KITE_API_KEY;
  if (!apiKey) {
    return res.status(500).send('KITE_API_KEY not set in Vercel environment variables.');
  }
  const url = `https://kite.trade/connect/login?api_key=${apiKey}&v=3`;
  res.redirect(302, url);
}
