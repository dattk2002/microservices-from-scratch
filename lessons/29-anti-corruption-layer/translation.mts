import { canonical, exact, id, integer, object } from './model.mts';
import type { Product } from './model.mts';
export function cents(value: unknown): number {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,13})\.[0-9]{2}$/.test(value)) throw new Error('decimal required');
  const result = BigInt(value.replace('.', ''));
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('price overflow');
  return Number(result);
}
export function translate(value: unknown, expected: string): Product {
  id(expected);
  const p = object(value);
  const v2 = Object.hasOwn(p, 'item');
  exact(p, v2 ? ['item','price','money','boxes','units_per_box','state','label'] :
    ['sku','unit_price','currency','packs','pack_size','status','description']);
  const alias = v2 ? p.item : p.sku;
  if (alias !== `${v2 ? 'N:' : 'L:'}${expected}`) throw new Error('identity mismatch');
  const status = v2 ? p.state : p.status;
  if (typeof status !== 'string' || !['A', 'O', 'D'].includes(status)) throw new Error('unsupported status');
  const packs = integer(v2 ? p.boxes : p.packs, 0, 1_000_000);
  const size = integer(v2 ? p.units_per_box : p.pack_size, 1, 1000);
  const units = integer(packs * size, 0, 1_000_000);
  if ((status === 'A') !== (units > 0)) throw new Error('contradictory stock');
  return canonical({id: expected, name: v2 ? p.label : p.description, unitCents: cents(v2 ? p.price : p.unit_price),
    currency: v2 ? p.money : p.currency, availableUnits: units, availability: status === 'A' ? 'available' : 'unavailable'}, expected);
}
// Each legal string code unit takes at most six JSON bytes (\\u0000).
// Include longest key set, numeric maxima and separators; whitespace is not part of our wire contract.
const worst = (n: number) => '\u0000'.repeat(n);
export const LEGACY_LIMIT = Math.max(
  Buffer.byteLength(JSON.stringify({sku: worst(66), unit_price: worst(17), currency: worst(3), packs: 1000000, pack_size: 1000, status: worst(1), description: worst(80)})),
  Buffer.byteLength(JSON.stringify({item: worst(66), price: worst(17), money: worst(3), boxes: 1000000, units_per_box: 1000, state: worst(1), label: worst(80)})));
