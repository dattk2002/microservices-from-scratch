import { HttpError, json, methodNotAllowed, numberSetting, serve } from '../../lib/http.mts';
import { Full, Pool, runBounded } from './bulkhead.mts';

function origin(name: string, fallback: string): string {
  const url = new URL(process.env[name] ?? fallback);
  if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error(`Invalid ${name}`);
  return url.origin;
}
export async function startGateway() {
  const dependencies = {
    catalog: { pool: new Pool(numberSetting('CATALOG_CAPACITY', 2, 1, 1000)), url: origin('CATALOG_URL', 'http://127.0.0.1:4311') },
    shipping: { pool: new Pool(numberSetting('SHIPPING_CAPACITY', 2, 1, 1000)), url: origin('SHIPPING_URL', 'http://127.0.0.1:4312') },
  };
  const deadlineMs = numberSetting('DEADLINE_MS', 1000, 10, 10000);
  return serve('bulkhead-gateway', 4310, async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const kind = url.pathname === '/catalog' ? 'catalog' : url.pathname === '/shipping' ? 'shipping' : undefined;
    if (!kind) throw new HttpError(404, 'not_found', 'Unknown route');
    if (req.method !== 'GET') methodNotAllowed(res, 'GET');
    if (url.search) throw new HttpError(400, 'invalid_query', 'No query parameters supported');
    const disconnected = new AbortController();
    const onClose = () => { if (!res.writableEnded) disconnected.abort(new Error('Client disconnected')); };
    res.once('close', onClose);
    const signal = AbortSignal.any([disconnected.signal, AbortSignal.timeout(deadlineMs)]);
    const dependency = dependencies[kind];
    try {
      await runBounded(dependency.pool, signal, async (signal) => {
        const response = await fetch(`${dependency.url}/work`, { signal, redirect: 'error' });
        try {
          if (response.status !== 200) throw new HttpError(502, 'dependency_failed', 'Downstream returned failure');
          // The response is a fixed, small acknowledgement; never buffer downstream bytes.
        } finally { await response.body?.cancel(); }
      });
      json(res, 200, { dependency: kind, state: 'ok' });
    } catch (error) {
      if (disconnected.signal.aborted) return;
      if (error instanceof Full) {
        res.setHeader('retry-after', '1');
        json(res, 503, { error: { code: 'bulkhead_full', dependency: kind } });
      } else if (signal.aborted) throw new HttpError(504, 'deadline_exceeded', 'Downstream deadline exceeded');
      else if (error instanceof HttpError) throw error;
      else throw new HttpError(502, 'dependency_unreachable', 'Downstream connection failed');
    } finally { res.off('close', onClose); }
  });
}
if (import.meta.main) await startGateway();
