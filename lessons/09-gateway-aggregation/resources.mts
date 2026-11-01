import { setTimeout as sleep } from 'node:timers/promises';
import { HttpError, json, methodNotAllowed, numberSetting, serve } from '../../lib/http.mts';
import { parseSku } from './contract.mts';
import type { Kind } from './contract.mts';

// Each process owns only its resource. These fixtures are independent, not a shared database.
export async function startResource(kind: Kind) {
  const delay = numberSetting('DELAY_MS', 0, 0, 5000);
  const mode = process.env.MODE ?? 'healthy';
  if (!['healthy', 'fail', 'invalid'].includes(mode)) throw new Error('Invalid MODE');
  return serve(kind, kind === 'catalog' ? 3901 : 3902, async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    if (url.pathname !== `/${kind}`) throw new HttpError(404, 'not_found', 'Unknown route');
    if (req.method !== 'GET') methodNotAllowed(res, 'GET');
    const sku = parseSku(url);
    console.log(JSON.stringify({ event: 'requested', sku }));
    await sleep(delay);
    if (res.destroyed) return;
    if (mode === 'fail') { json(res, 503, { error: 'maintenance' }); return; }
    if (mode === 'invalid') { json(res, 200, { sku, broken: true }); return; }
    if (sku !== 'tea-01') throw new HttpError(404, 'resource_not_found', 'Unknown SKU');
    if (kind === 'catalog') json(res, 200, { sku, name: 'Trà sen', priceCents: 42000 });
    else json(res, 200, { sku, available: 7 });
  });
}
