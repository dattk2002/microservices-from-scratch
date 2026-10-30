export type V1Product = { id: string; name: string; priceCents: number };
export function parseV1Product(value: unknown, expectedId: string): V1Product {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected product object');
  if (!('id' in value) || typeof value.id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(value.id) || value.id !== expectedId ||
      !('name' in value) || typeof value.name !== 'string' || value.name.trim().length === 0 ||
      !('priceCents' in value) || typeof value.priceCents !== 'number' || !Number.isSafeInteger(value.priceCents) || value.priceCents < 0) {
    throw new Error('Invalid v1 product');
  }
  return { id: value.id, name: value.name, priceCents: value.priceCents };
}
