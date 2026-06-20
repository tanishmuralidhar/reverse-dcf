// Vercel serverless function — GET /api/company/:ticker
// Reuses the same data layer as the local Express server (lib/provider.js), so
// there is one source of truth. No API key is required by yahoo-finance2.
import { getCompany } from '../lib/provider.js';

// Module-scope cache: persists across warm invocations on the same instance.
const cache = new Map();
const TTL_MS = 5 * 60 * 1000;

export default async function handler(req, res) {
  if (req.method && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  const ticker = String(req.query.ticker || '').trim().toUpperCase();
  const hit = cache.get(ticker);
  if (hit && Date.now() - hit.t < TTL_MS) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(hit.data);
  }
  try {
    const data = await getCompany(ticker);
    cache.set(ticker, { t: Date.now(), data });
    // Cache at Vercel's edge too: fresh for 2 min, served-stale while revalidating.
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    return res.status(200).json(data);
  } catch (err) {
    // serve-stale-on-error if we still hold an expired copy
    if (hit) {
      res.setHeader('X-Cache', 'STALE');
      return res.status(200).json(hit.data);
    }
    return res.status(err.status || 502).json({ error: err.message || 'Upstream data error.' });
  }
}
