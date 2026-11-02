import { HttpError } from '../../lib/http.mts';
export type Status = 'open' | 'shipped';
export type Event = { seq: number; eventId: string; orderId: string; version: number; quantity: number; status: Status; occurredAt: number };
export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'invalid_input', 'Expected object');
  return value as Record<string, unknown>;
}
export function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new HttpError(400, 'invalid_input', 'Invalid integer');
  return value;
}
export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(value)) throw new HttpError(400, 'invalid_input', 'Invalid ID');
  return value;
}
export function status(value: unknown): Status {
  if (value !== 'open' && value !== 'shipped') throw new HttpError(400, 'invalid_input', 'Use open or shipped');
  return value;
}
export function parseEvent(value: unknown): Event {
  const v = object(value);
  return { seq: integer(v.seq, 1), eventId: identifier(v.eventId), orderId: identifier(v.orderId),
    version: integer(v.version, 1), quantity: integer(v.quantity, 1, 1000), status: status(v.status), occurredAt: integer(v.occurredAt, 0) };
}
export function conflict(code: string): never { throw new HttpError(409, code, code); }
