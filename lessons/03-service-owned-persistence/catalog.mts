import { fileURLToPath } from 'node:url';
import { HttpError, json, methodNotAllowed, serve } from '../../lib/http.mts';
import { CatalogStore } from './store.mts';

async function main() {
  const store = new CatalogStore(process.env.CATALOG_DB_PATH ?? fileURLToPath(new URL('./data/catalog.sqlite', import.meta.url)));
  try {
    const server = await serve('catalog', 3301, (req, res) => {
      const path = new URL(req.url ?? '/', 'http://local.invalid').pathname;
      if (path === '/health') {
        if (req.method !== 'GET') methodNotAllowed(res, 'GET');
        json(res, 200, { status: 'ok', service: 'catalog' }); return;
      }
      const match = /^\/products\/([a-z0-9-]{1,32})$/.exec(path);
      if (match?.[1]) {
        if (req.method !== 'GET') methodNotAllowed(res, 'GET');
        const product = store.get(match[1]);
        if (!product) throw new HttpError(404, 'product_not_found', 'Product does not exist');
        json(res, 200, product); return;
      }
      throw new HttpError(404, 'not_found', 'Route does not exist');
    });
    server.once('close', () => store.close());
  } catch (error) { store.close(); throw error; }
}

if (import.meta.main) await main();
