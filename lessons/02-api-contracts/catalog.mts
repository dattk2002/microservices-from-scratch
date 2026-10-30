import { HttpError, json, methodNotAllowed, serve } from '../../lib/http.mts';

// These modes deliberately simulate provider deployments, not client input.
const mode = process.env.CATALOG_MODE ?? 'baseline';
if (!['baseline', 'additive', 'incompatible'].includes(mode)) throw new Error('Invalid CATALOG_MODE');
await serve('catalog-contracts', 4201, (req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path === '/health') { json(res, 200, { status: 'ok' }); return; }
  const match = /^\/v([12])\/products\/([a-z0-9-]{1,64})$/.exec(path);
  if (!match) throw new HttpError(404, 'not_found', 'Unknown route');
  if (req.method !== 'GET') methodNotAllowed(res, 'GET');
  if (match[2] !== 'pencil') throw new HttpError(404, 'product_not_found', 'Unknown product');
  const base = { id: 'pencil', name: 'Bút chì' };
  if (match[1] === '2') {
    json(res, 200, { ...base, price: { amountCents: 125, currency: 'USD' } });
  } else if (mode === 'incompatible') {
    json(res, 200, { ...base, priceCents: '125' });
  } else {
    json(res, 200, { ...base, priceCents: 125, ...(mode === 'additive' ? { stock: 40, tags: ['stationery'] } : {}) });
  }
});
