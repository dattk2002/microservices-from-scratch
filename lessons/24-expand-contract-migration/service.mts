import { HttpError, json, readJson, serve } from '../../lib/http.mts';
import { Catalog, Conflict } from './store.mts';
import type { Version } from './store.mts';

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'invalid_body', 'Expected object');
  return value as Record<string, unknown>;
}
function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new HttpError(400, 'invalid_id', 'Expected positive integer');
  return value;
}
export async function start(role: Version | 'control') {
  const path = process.env.CATALOG_DB;
  if (!path) throw new Error('CATALOG_DB required');
  const catalog = new Catalog(path);
  try {
    const server = await serve(`catalog-${role}`, 3024, async (req, res) => {
      try {
        // Check every old request, including status and admission, after contract.
        if (role === 'old' && catalog.status().phase === 'contracted') throw new Conflict('contract: old binary incompatible');
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (req.method === 'GET' && url.pathname === '/status') return json(res, 200, catalog.status());
        if (role === 'control') {
          if (req.method !== 'POST') throw new HttpError(405, 'method', 'Use POST');
          const body = object(await readJson(req));
          switch (url.pathname) {
            case '/expand': catalog.expand(); break;
            case '/batch': {
              const size = positive(body.size);
              if (size > 100 || (body.interrupt !== undefined && typeof body.interrupt !== 'boolean')) throw new HttpError(400, 'invalid_batch', 'size 1..100, interrupt boolean');
              catalog.batch(size, body.interrupt === true); break;
            }
            case '/retire': catalog.retire(); break;
            case '/contract': catalog.contract(); break;
            default: throw new HttpError(404, 'not_found', 'Unknown operation');
          }
          return json(res, 200, catalog.status());
        }
        const match = /^\/products\/([1-9]\d*)$/.exec(url.pathname);
        if (req.method === 'GET' && match) {
          const name = catalog.read(role, positive(Number(match[1])));
          if (name === undefined) throw new HttpError(404, 'not_found', 'Unknown product');
          return json(res, 200, {id: Number(match[1]), name});
        }
        if (req.method === 'POST' && (url.pathname === '/products' || (role === 'old' && ['/admit', '/complete'].includes(url.pathname)))) {
          const body = object(await readJson(req));
          if (url.pathname === '/complete') return json(res, 200, {id: catalog.complete(positive(body.ticket))});
          const id = positive(body.id);
          if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100) throw new HttpError(400, 'invalid_name', 'name 1..100 chars');
          if (url.pathname === '/admit') return json(res, 202, {ticket: catalog.admit(id, body.name)});
          catalog.write(role, id, body.name);
          return json(res, 200, {id, name: body.name});
        }
        throw new HttpError(404, 'not_found', 'Unknown route');
      } catch (error) {
        if (error instanceof Conflict) throw new HttpError(409, 'migration_conflict', error.message);
        throw error;
      }
    });
    server.once('close', () => catalog.close());
    return server;
  } catch (error) { catalog.close(); throw error; }
}
