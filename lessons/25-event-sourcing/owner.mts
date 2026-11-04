import { HttpError, json, methodNotAllowed, readJson, serve } from '../../lib/http.mts';
import { cartId, integer, record } from './model.mts';
import { Store } from './store.mts';
export async function main() {
  const path = process.env.CART_DB;
  if (!path) throw new Error('CART_DB required');
  const store = new Store(path);
  try {
    const server = await serve('cart-event-owner', 3025, async (req, res) => {
      const deadline = setTimeout(() => req.destroy(), 1500);
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const match = /^\/carts\/([^/]+)\/(commands|events|state|snapshot)$/.exec(url.pathname);
        if (!match) throw new HttpError(404, 'not_found', 'Unknown route');
        const id = cartId(match[1]!);
        const action = match[2];
        const method = action === 'commands' || action === 'snapshot' ? 'POST' : 'GET';
        if (req.method !== method) methodNotAllowed(res, method);
        if (action === 'commands') {
          const body = record(await readJson(req));
          if (Object.keys(body).sort().join() !== 'command,expectedVersion') throw new HttpError(400, 'invalid_command', 'Expected command and expectedVersion');
          json(res, 201, store.append(id, integer(body.expectedVersion, 0, 128), body.command));
        } else if (action === 'events') {
          const after = url.searchParams.get('after') ?? '0';
          const limit = url.searchParams.get('limit') ?? '16';
          if (!/^\d+$/.test(after) || !/^\d+$/.test(limit)) throw new HttpError(400, 'invalid_page', 'Use integer page parameters');
          json(res, 200, store.history(id, Number(after), Number(limit)));
        } else {
          const state = action === 'snapshot' ? store.snapshot(id) : store.state(id);
          if (!state.version) throw new HttpError(404, 'not_found', 'Cart not found');
          json(res, 200, state);
        }
      } finally { clearTimeout(deadline); }
    });
    server.once('close', () => store.close());
    return server;
  } catch (error) { store.close(); throw error; }
}
if (import.meta.main) await main();
