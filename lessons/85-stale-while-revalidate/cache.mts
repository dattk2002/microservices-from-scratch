import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { json, methodNotAllowed, serve } from '../../lib/http.mts';
import { fail, lessonHandler, pathOf, requireNoBody } from './http-contract.mts';
import { fetchOrigin, normalizeOrigin } from './upstream.mts';
import { ValueCache } from './value-cache.mts';

export async function main(): Promise<void> {
  const origin = normalizeOrigin(process.env.ORIGIN_ORIGIN);
  const now = () => performance.now();
  const cache = new ValueCache(now, signal => fetchOrigin(origin, signal, now));
  const stop = () => { void cache.close(); };
  try {
    const server = await serve('swr-cache', 4085, lessonHandler(async (req, res) => {
      if (pathOf(req) !== '/value') fail(404, 'not_found');
      if (req.method !== 'GET') methodNotAllowed(res, 'GET');
      requireNoBody(req);

      let snapshot;
      try {
        snapshot = await cache.get();
      } catch {
        fail(502, 'upstream_failure');
      }
      json(res, 200, snapshot);
    }));
    server.maxHeadersCount = 0;
    try {
      // The shared server also handles these signals and closes its listener.
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      await once(server, 'close');
    } finally {
      if (server.listening) {
        server.close();
        server.closeAllConnections();
      }
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await cache.close();
  }
}

if (import.meta.main) await main();
