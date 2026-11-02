import { pathToFileURL } from 'node:url';
import { HttpError, json, methodNotAllowed, readJson, serve } from '../../lib/http.mts';
import { identifier, integer, object, status } from './protocol.mts';
import { Orders } from './store.mts';
export async function main() {
  if (!process.env.DB_PATH) throw new Error('DB_PATH required');
  const store = new Orders(process.env.DB_PATH);
  try {
    const server = await serve('cqrs-orders', 4151, async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/events') {
        if (req.method !== 'GET') methodNotAllowed(res, 'GET');
        const raw = url.searchParams.get('after') ?? '0';
        if (!/^\d+$/.test(raw)) throw new HttpError(400, 'invalid_cursor', 'Use nonnegative after');
        json(res, 200, store.events(integer(Number(raw), 0))); return;
      }
      if (url.pathname.startsWith('/orders/')) {
        if (req.method !== 'GET') methodNotAllowed(res, 'GET');
        const order = store.get(identifier(url.pathname.slice(8)));
        if (!order) throw new HttpError(404, 'not_found', 'Unknown order');
        json(res, 200, order); return;
      }
      if (url.pathname !== '/orders') throw new HttpError(404, 'not_found', 'Unknown route');
      if (req.method !== 'POST') methodNotAllowed(res, 'POST');
      const body = object(await readJson(req));
      const event = store.command(identifier(body.id), integer(body.expectedVersion, 0), integer(body.quantity, 1, 1000), status(body.status));
      json(res, event.version === 1 ? 201 : 200, { orderId: event.orderId, version: event.version, eventId: event.eventId, sequence: event.seq });
    });
    server.once('close', () => store.close());
  } catch (error) { store.close(); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
