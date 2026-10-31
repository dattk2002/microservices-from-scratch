import { createHash } from 'node:crypto';
import { HttpError } from '../../lib/http.mts';

export type OrderInput = { productId: string; quantity: number };
export type Product = { id: string; name: string; priceCents: number };
export function parseKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(value)) {
    throw new HttpError(400, 'invalid_idempotency_key', 'Use one Idempotency-Key of 1..128 ASCII letters, digits, colon, underscore or hyphen');
  }
  return value;
}
export function parseInput(value: unknown): OrderInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      !('productId' in value) || typeof value.productId !== 'string' ||
      !/^[a-z0-9-]{1,64}$/.test(value.productId.trim()) ||
      !('quantity' in value) || typeof value.quantity !== 'number' ||
      !Number.isSafeInteger(value.quantity) || value.quantity < 1 || value.quantity > 100 ||
      Object.keys(value).some(key => key !== 'productId' && key !== 'quantity')) {
    throw new HttpError(400, 'invalid_order', 'Use productId and integer quantity 1..100 only');
  }
  return { productId: value.productId.trim(), quantity: value.quantity };
}
export function fingerprint(input: OrderInput): string {
  return createHash('sha256').update(JSON.stringify([input.productId, input.quantity])).digest('hex');
}
export function parseProduct(value: unknown, expectedId: string): Product {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      !('id' in value) || value.id !== expectedId ||
      !('name' in value) || typeof value.name !== 'string' || value.name.trim().length === 0 || value.name.length > 200 ||
      !('priceCents' in value) || typeof value.priceCents !== 'number' ||
      !Number.isSafeInteger(value.priceCents) || value.priceCents < 0 ||
      value.priceCents > Math.floor(Number.MAX_SAFE_INTEGER / 100)) {
    throw new HttpError(502, 'catalog_invalid_response', 'Invalid Catalog product');
  }
  return { id: expectedId, name: value.name, priceCents: value.priceCents };
}
