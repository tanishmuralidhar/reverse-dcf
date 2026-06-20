// Reverse DCF — Express server.
// Serves the static frontend and exposes /api/company/:ticker with normalized
// fundamentals pulled from Yahoo Finance (no API key required).
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCompany } from './lib/provider.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 5050;

// ---- tiny bounded in-memory cache (a ticker rarely changes within minutes) ----
const cache = new Map();
const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 500;

app.get('/api/company/:ticker', async (req, res) => {
  const ticker = String(req.params.ticker || '').trim().toUpperCase();
  const hit = cache.get(ticker);
  if (hit && Date.now() - hit.t < TTL_MS) {
    res.set('X-Cache', 'HIT');
    return res.json(hit.data);
  }
  try {
    const data = await getCompany(ticker);
    // bound the cache: drop the oldest entry once we exceed the cap
    if (cache.size >= MAX_ENTRIES && !cache.has(ticker)) {
      cache.delete(cache.keys().next().value);
    }
    cache.set(ticker, { t: Date.now(), data });
    res.set('Cache-Control', 'public, max-age=120');
    res.json(data);
  } catch (err) {
    // serve-stale-on-error: if a refetch fails but we hold an expired copy,
    // return it rather than erroring out on a transient upstream blip.
    if (hit) {
      res.set('X-Cache', 'STALE');
      return res.json(hit.data);
    }
    const status = err.status || 502;
    res.status(status).json({ error: err.message || 'Upstream data error.' });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ---- static frontend (served from the project root, matching the Vercel layout) ----
app.use(express.static(__dirname, { extensions: ['html'] }));

app.listen(PORT, () => {
  console.log(`Reverse DCF running →  http://localhost:${PORT}`);
});
