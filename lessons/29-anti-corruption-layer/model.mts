export type Product = {id: string; name: string; unitCents: number; currency: 'USD'; availableUnits: number; availability: 'available' | 'unavailable'};
export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
  return Object.fromEntries(Object.entries(value));
}
export function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) throw new Error('ambiguous or missing fields');
}
export function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(value)) throw new Error('invalid product id');
  return value;
}
export function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error('integer out of bounds');
  return value;
}
export function canonical(value: unknown, expected: string): Product {
  const p = object(value);
  exact(p, ['id', 'name', 'unitCents', 'currency', 'availableUnits', 'availability']);
  if (id(p.id) !== expected || typeof p.name !== 'string' || p.name.length < 1 || p.name.length > 80 ||
      typeof p.currency !== 'string' || p.currency !== 'USD' || typeof p.availability !== 'string' ||
      !['available', 'unavailable'].includes(p.availability)) throw new Error('invalid canonical semantics');
  const availableUnits = integer(p.availableUnits, 0, 1_000_000);
  if ((p.availability === 'available') !== (availableUnits > 0)) throw new Error('contradictory availability');
  return {id: expected, name: p.name, unitCents: integer(p.unitCents, 0, Number.MAX_SAFE_INTEGER), currency: p.currency,
    availableUnits, availability: p.availability === 'available' ? 'available' : 'unavailable'};
}
const worst = (n: number) => '\u0000'.repeat(n);
export const CANONICAL_LIMIT = Buffer.byteLength(JSON.stringify({id: worst(64), name: worst(80), unitCents: Number.MAX_SAFE_INTEGER,
  currency: worst(3), availableUnits: 1000000, availability: worst(11)}));
