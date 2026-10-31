import { HttpError, json, methodNotAllowed, serve } from '../../lib/http.mts';

export async function main(): Promise<void> {
  await serve('catalog-idempotency', 4501, (req, res) => {
    if (req.method !== 'GET') methodNotAllowed(res, 'GET');
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/health') { json(res, 200, { status: 'ok' }); return; }
    if (path !== '/products/pencil') throw new HttpError(404, 'not_found', 'Unknown product');
    json(res, 200, { id: 'pencil', name: 'Bút chì', priceCents: 125 });
  });
}
if (import.meta.main) await main();
