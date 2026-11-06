import { buildRequest, parseReply } from './contracts.mts';
import type { Product } from './contracts.mts';
import { upstream, REQUEST_MS } from './transport.mts';

export async function consume(origin: string, id: unknown, total: AbortSignal): Promise<Product> {
  const request = buildRequest(id);
  const signal = AbortSignal.any([total, AbortSignal.timeout(REQUEST_MS)]);
  const reply = await upstream(origin, request, signal);
  return parseReply(id, reply.status, reply.body);
}
export function quote(product: Product): {available: boolean; totalCents: number} {
  return product.kind === 'found' ? {available: true, totalCents: product.priceCents * 2} : {available: false, totalCents: 0};
}
