import { HttpError, json, methodNotAllowed, numberSetting, serve } from '../../lib/http.mts';
import { combine, parseSku, validResource } from './contract.mts';
import type { Kind, Outcome } from './contract.mts';

function origin(name: string, fallback: string): string {
  const url = new URL(process.env[name] ?? fallback);
  if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`Invalid ${name}: expected HTTP origin`);
  }
  return url.origin;
}

async function dependency(kind: Kind, base: string, sku: string, budget: number, overall: AbortSignal): Promise<Outcome> {
  const signal = AbortSignal.any([overall, AbortSignal.timeout(budget)]);
  let phase: 'unreachable' | 'invalid_response' = 'unreachable';
  try {
    const response = await fetch(`${base}/${kind}?sku=${encodeURIComponent(sku)}`, { signal, redirect: 'error' });
    phase = 'invalid_response';
    if (response.status !== 200) {
      await response.body?.cancel();
      return { state: 'error', code: 'upstream_status' };
    }
    if (!response.headers.get('content-type')?.startsWith('application/json')) {
      await response.body?.cancel();
      return { state: 'error', code: 'invalid_response' };
    }
    // Bound bytes as well as time; do not buffer an arbitrarily large JSON body.
    const reader = response.body?.getReader();
    if (!reader) return { state: 'error', code: 'invalid_response' };
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 8192) {
          await reader.cancel();
          return { state: 'error', code: 'invalid_response' };
        }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!validResource(kind, value, sku)) return { state: 'error', code: 'invalid_response' };
    // Project the public fields: downstream additions do not silently leak through.
    if (kind === 'stock' && 'available' in value) return { state: 'ok', data: { sku, available: value.available } };
    if (kind === 'catalog' && 'name' in value) return { state: 'ok', data: { sku, name: value.name, priceCents: value.priceCents } };
    return { state: 'error', code: 'invalid_response' };
  } catch {
    return { state: 'error', code: signal.aborted ? 'timeout' : phase };
  }
}

export async function startGateway() {
  const catalog = origin('CATALOG_URL', 'http://127.0.0.1:3901');
  const stock = origin('STOCK_URL', 'http://127.0.0.1:3902');
  const catalogMs = numberSetting('CATALOG_TIMEOUT_MS', 400, 10, 5000);
  const stockMs = numberSetting('STOCK_TIMEOUT_MS', 300, 10, 5000);
  const overallMs = numberSetting('OVERALL_TIMEOUT_MS', 500, 10, 5000);
  return serve('gateway', 3900, async (req, res) => {
    const started = performance.now();
    const url = new URL(req.url ?? '/', 'http://local');
    if (url.pathname !== '/product') throw new HttpError(404, 'not_found', 'Unknown route');
    if (req.method !== 'GET') methodNotAllowed(res, 'GET');
    const sku = parseSku(url);
    const overall = AbortSignal.timeout(Math.max(1, Math.ceil(overallMs - (performance.now() - started))));
    const [catalogResult, stockResult] = await Promise.all([
      dependency('catalog', catalog, sku, catalogMs, overall),
      dependency('stock', stock, sku, stockMs, overall),
    ]);
    const result = combine(catalogResult, stockResult);
    if (!res.destroyed) json(res, result.status, result.body);
  });
}
if (import.meta.main) await startGateway();
