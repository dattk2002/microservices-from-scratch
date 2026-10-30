import { HttpError } from '../../lib/http.mts';
export type OrderInput = { productId: string; quantity: number };
export function parseOrderInput(value: unknown): OrderInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'invalid_order', 'Expected an order object');
  }
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some((key) => !['productId', 'quantity'].includes(key))
      || typeof data.productId !== 'string' || !/^[a-z0-9-]{1,32}$/.test(data.productId)
      || typeof data.quantity !== 'number' || !Number.isInteger(data.quantity)
      || data.quantity < 1 || data.quantity > 100) {
    throw new HttpError(400, 'invalid_order', 'Use productId and integer quantity from 1 to 100');
  }
  return { productId: data.productId, quantity: data.quantity };
}
