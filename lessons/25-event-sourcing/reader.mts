import { HttpError, json, methodNotAllowed, serve } from '../../lib/http.mts';
import { cartId, integer, record, replay, MAX_EVENTS } from './model.mts';
import type { State } from './model.mts';
export async function reconstruct(base: string, id: string): Promise<State> {
  cartId(id);
  const signal = AbortSignal.timeout(1200);
  let state: State = { version: 0, items: {}, checkedOut: false };
  let target: number | undefined;
  try {
    for (let page = 0; page < MAX_EVENTS / 4; page++) {
      const response = await fetch(`${base}/carts/${id}/events?after=${state.version}&limit=4`, { signal, redirect: 'error' });
      if (!response.ok) throw new Error('Owner failed');
      // Bound bytes before JSON parsing, including chunked responses.
      if (!response.body) throw new Error('Missing history');
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 8192) throw new Error('History too large');
        chunks.push(chunk);
      }
      const body = record(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      const version = integer(body.version, 0, MAX_EVENTS);
      target ??= version;
      if (version < target || !Array.isArray(body.events) || body.events.length !== Math.min(4, version - state.version)) throw new Error('Invalid page');
      // Fix the first observed stream boundary; concurrent appends belong to the next read.
      replay(body.events, state);
      const remaining = target - state.version;
      const events: unknown[] = body.events.slice(0, remaining);
      if (remaining && !events.length) throw new Error('Missing events');
      state = replay(events, state);
      if (state.version === target) return state;
    }
    throw new Error('Page budget exceeded');
  } catch { throw new HttpError(502, 'invalid_history', 'Owner unavailable or invalid history'); }
}
export async function main() {
  const base = process.env.OWNER_URL;
  if (!base) throw new Error('OWNER_URL required');
  const url = new URL(base);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('OWNER_URL must be loopback origin');
  let active = 0;
  return serve('cart-reader', 3026, async (req, res) => {
    const match = /^\/carts\/([^/]+)$/.exec(new URL(req.url ?? '/', 'http://localhost').pathname);
    if (!match) throw new HttpError(404, 'not_found', 'Unknown route');
    if (req.method !== 'GET') methodNotAllowed(res, 'GET');
    const id = cartId(match[1]!);
    if (active >= 8) throw new HttpError(503, 'busy', 'Reader capacity reached');
    active++;
    try {
      const state = await reconstruct(url.origin, id);
      if (!state.version) throw new HttpError(404, 'not_found', 'Cart not found');
      json(res, 200, state);
    } finally { active--; }
  });
}
if (import.meta.main) await main();
