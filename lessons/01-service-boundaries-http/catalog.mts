import { HttpError, json, methodNotAllowed, serve } from '../../lib/http.mts';

// Only Catalog owns product data; Orders obtains it over HTTP.
const products = new Map([['pencil', {id: 'pencil', name: 'Pencil', priceCents: 125}]]);

await serve('catalog', 3101, (req, res) => {
  const path = new URL(req.url ?? '/', 'http://local.invalid').pathname;
  if (path === '/health') {
    if (req.method !== 'GET') methodNotAllowed(res, 'GET');
    json(res, 200, {status: 'ok', service: 'catalog'}); return;
  }
  const match = /^\/products\/([a-z0-9-]{1,32})$/.exec(path);
  if (match?.[1]) {
    if (req.method !== 'GET') methodNotAllowed(res, 'GET');
    const product = products.get(match[1]);
    if (!product) throw new HttpError(404, 'product_not_found', 'Product does not exist');
    json(res, 200, product); return;
  }
  throw new HttpError(404, 'not_found', 'Route does not exist');
});
