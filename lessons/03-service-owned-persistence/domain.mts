import { HttpError } from '../../lib/http.mts';

export type OrderInput = Readonly<{ productId: string; quantity: number }>;
export type Product = Readonly<{ id: string; name: string; priceCents: number }>;
export type Order = Readonly<{ id: string; product: Product; quantity: number; totalCents: number }>;
export const orderIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseOrderInput(value: unknown): OrderInput {
  if (!isRecord(value) || Object.keys(value).some((key) => !['productId', 'quantity'].includes(key))
      || typeof value.productId !== 'string' || !/^[a-z0-9-]{1,32}$/.test(value.productId)
      || typeof value.quantity !== 'number' || !Number.isInteger(value.quantity)
      || value.quantity < 1 || value.quantity > 100) {
    throw new HttpError(400, 'invalid_order', 'Use productId and integer quantity from 1 to 100');
  }
  return { productId: value.productId, quantity: value.quantity };
}

export const invalidProduct = () => new HttpError(502, 'catalog_invalid_response', 'Catalog returned an invalid product');

export function parseProduct(value: unknown, id: string): Product {
  if (!isRecord(value) || value.id !== id || typeof value.name !== 'string'
      || value.name.trim().length < 1 || value.name.length > 100
      || typeof value.priceCents !== 'number' || !Number.isSafeInteger(value.priceCents)
      || value.priceCents < 0 || value.priceCents > 100_000_000) throw invalidProduct();
  return Object.freeze({ id, name: value.name, priceCents: value.priceCents });
}

export function snapshot(id: string, input: OrderInput, product: Product): Order {
  const validatedInput = parseOrderInput(input);
  const copiedProduct = parseProduct(product, validatedInput.productId);
  if (!orderIdPattern.test(id)) throw new Error('Invalid order id');
  return Object.freeze({ id, product: copiedProduct, quantity: validatedInput.quantity,
    totalCents: copiedProduct.priceCents * validatedInput.quantity });
}
