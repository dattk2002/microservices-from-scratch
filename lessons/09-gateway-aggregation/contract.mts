import { HttpError } from '../../lib/http.mts';

export type Kind = 'catalog' | 'stock';
export type Resource = { sku: string; name: string; priceCents: number } | { sku: string; available: number };
export type Outcome = { state: 'ok'; data: Resource } |
  { state: 'error'; code: 'timeout' | 'unreachable' | 'upstream_status' | 'invalid_response' };

export function parseSku(url: URL): string {
  const values = url.searchParams.getAll('sku');
  const sku = values[0];
  if (values.length !== 1 || !sku || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(sku)
      || [...url.searchParams.keys()].some(key => key !== 'sku')) {
    throw new HttpError(400, 'invalid_sku', 'Use exactly one sku: 1..32 lowercase ASCII letters, digits or hyphens');
  }
  return sku;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
export function validResource(kind: Kind, value: unknown, sku: string): value is Resource {
  if (!record(value) || value.sku !== sku) return false;
  return kind === 'stock' ? count(value.available) :
    typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 100 && count(value.priceCents);
}
export function combine(catalog: Outcome, stock: Outcome) {
  const successes = Number(catalog.state === 'ok') + Number(stock.state === 'ok');
  return { status: successes === 0 ? 503 : 200,
    body: { state: successes === 2 ? 'complete' : successes === 1 ? 'partial' : 'unavailable', catalog, stock } };
}
