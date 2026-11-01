import { json, numberSetting } from '../../lib/http.mts';
import { context, logLine } from './context.mts';
import { start } from './service.mts';

export async function main() {
  const catalog = new URL(process.env.CATALOG_URL ?? 'http://127.0.0.1:4801');
  if (catalog.protocol !== 'http:' || catalog.username || catalog.password || catalog.search || catalog.hash || catalog.pathname !== '/') {
    throw new Error('CATALOG_URL must be an HTTP origin without credentials');
  }
  const timeout = numberSetting('TIMEOUT_MS', 1000, 1, 5000);
  return start('gateway', 4800, async (_req, res) => {
    const id = context.getStore()!.id;
    const signal = AbortSignal.timeout(timeout);
    try {
      const upstream = await fetch(new URL('/quote', catalog), {
        headers: { 'x-correlation-id': id }, signal,
      });
      // Consume the body inside the same deadline; don't relay arbitrary upstream content.
      const body: unknown = await upstream.json();
      console.log(logLine('gateway', 'upstream_finished', upstream.status));
      if (upstream.status !== 200 || upstream.headers.get('x-correlation-id') !== id
        || typeof body !== 'object' || body === null || !('correlationId' in body) || body.correlationId !== id
        || !('priceCents' in body) || typeof body.priceCents !== 'number'
        || !Number.isSafeInteger(body.priceCents) || body.priceCents < 0) {
        json(res, 502, { error: 'upstream_invalid_response' }); return;
      }
      json(res, 200, { priceCents: body.priceCents, correlationId: id });
    } catch {
      const status = signal.aborted ? 504 : 502;
      console.log(logLine('gateway', 'upstream_finished', status));
      json(res, status, { error: signal.aborted ? 'upstream_timeout' : 'upstream_unavailable' });
    }
  });
}
if (import.meta.main) await main();
