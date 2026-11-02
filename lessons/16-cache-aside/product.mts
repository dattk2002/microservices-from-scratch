import { HttpError } from '../../lib/http.mts';
export type Product = Readonly<{ id: string; price: number; version: number }>;
export function product(value: unknown, expectedId: string): Product {
  if (typeof value !== 'object' || value === null || !('id' in value) || value.id !== expectedId ||
      !('price' in value) || typeof value.price !== 'number' || !Number.isSafeInteger(value.price) || value.price < 0 ||
      !('version' in value) || typeof value.version !== 'number' || !Number.isSafeInteger(value.version) || value.version < 1) {
    throw new HttpError(502, 'invalid_upstream', 'Catalog JSON violates product contract');
  }
  return Object.freeze({ id: expectedId, price: value.price, version: value.version });
}
export function key(path: string): string | undefined {
  return /^\/products\/([abc])$/.exec(path)?.[1];
}
