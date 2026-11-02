import { HttpError, json, methodNotAllowed, numberSetting, serve } from '../../lib/http.mts';
import { Buckets, validClient } from './bucket.mts';

export async function startGateway() {
  const buckets = new Buckets({
    capacity: numberSetting('CAPACITY', 3, 1, 1000),
    refillMs: numberSetting('REFILL_MS', 1000, 1, 3600000),
    maxClients: numberSetting('MAX_CLIENTS', 100, 1, 10000),
    idleMs: numberSetting('IDLE_MS', 60000, 1, 86400000),
  }, () => performance.now());
  const downstream = new URL(process.env.DOWNSTREAM_URL ?? 'http://127.0.0.1:4411');
  if (downstream.protocol !== 'http:' || downstream.username || downstream.password || downstream.pathname !== '/' || downstream.search || downstream.hash) {
    throw new Error('Invalid DOWNSTREAM_URL');
  }
  const deadlineMs = numberSetting('DEADLINE_MS', 1000, 10, 10000);
  return serve('token-gateway', 4410, async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    if (url.pathname !== '/work') throw new HttpError(404, 'not_found', 'Unknown route');
    if (req.method !== 'GET') methodNotAllowed(res, 'GET');
    if (url.search) throw new HttpError(400, 'invalid_query', 'No query parameters supported');
    const client = req.headers['x-demo-client'];
    if (!validClient(client)) throw new HttpError(400, 'invalid_client', 'Use one lowercase demo ID of 1..32 characters');
    const decision = buckets.take(client);
    if (decision.kind === 'limited') {
      res.setHeader('retry-after', String(decision.retryAfter));
      json(res, 429, { error: { code: 'rate_limited' } });
      return;
    }
    if (decision.kind === 'full') {
      json(res, 503, { error: { code: 'client_table_full' } });
      return;
    }
    const disconnected = new AbortController();
    const onClose = () => { if (!res.writableEnded) disconnected.abort(); };
    res.once('close', onClose);
    const signal = AbortSignal.any([disconnected.signal, AbortSignal.timeout(deadlineMs)]);
    try {
      const response = await fetch(`${downstream.origin}/work`, { signal, redirect: 'error' });
      try {
        if (response.status !== 200) throw new HttpError(502, 'dependency_failed', 'Downstream returned failure');
      } finally { await response.body?.cancel(); }
      json(res, 200, { state: 'ok' });
    } catch (error) {
      if (disconnected.signal.aborted) return;
      if (signal.aborted) throw new HttpError(504, 'deadline_exceeded', 'Downstream deadline exceeded');
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, 'dependency_unreachable', 'Downstream connection failed');
    } finally { res.off('close', onClose); }
  });
}
if (import.meta.main) await startGateway();
