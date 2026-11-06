// Consumer-owned catalogue: a teaching format, deliberately not Pact.
type Interaction = {
  readonly id: 'product-found' | 'product-missing';
  readonly request: {readonly method: 'GET'; readonly path: string};
  readonly status: number;
  readonly fields: Readonly<Record<string, 'string' | 'integer'>>;
};
export const catalogue = Object.freeze([
  {id: 'product-found', request: {method: 'GET', path: '/products/tea'}, status: 200, fields: {id: 'string', priceCents: 'integer'}},
  {id: 'product-missing', request: {method: 'GET', path: '/products/absent'}, status: 404, fields: {code: 'string'}},
] as const satisfies readonly Interaction[]);
export type InteractionId = typeof catalogue[number]['id'];
export type Product = {kind: 'found'; priceCents: number} | {kind: 'missing'};
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function interaction(id: unknown): Interaction {
  if (typeof id !== 'string') throw new Error('interaction: expected string');
  const item = catalogue.find(item => item.id === id);
  if (!item) throw new Error('interaction: unknown');
  return item;
}
export function buildRequest(id: unknown): {method: 'GET'; path: string} {
  return {...interaction(id).request};
}
export function parseReply(id: unknown, status: number, body: unknown): Product {
  const item = interaction(id);
  if (status !== item.status) throw new Error(`status: expected ${item.status}`);
  if (!record(body)) throw new Error('body: expected object');
  for (const [field, type] of Object.entries(item.fields)) {
    const value = body[field];
    if (type === 'string' ? typeof value !== 'string' : typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throw new Error(`${field}: expected ${type}`);
    }
  }
  if (item.id === 'product-missing') {
    if (body.code !== 'PRODUCT_MISSING') throw new Error('code: expected PRODUCT_MISSING');
    return {kind: 'missing'};
  }
  if (body.id !== 'tea') throw new Error('id: expected tea');
  const price = body.priceCents;
  if (typeof price !== 'number' || price < 0 || price > 100000) throw new Error('priceCents: expected 0..100000');
  return {kind: 'found', priceCents: price};
}
