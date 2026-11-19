import { createHash } from 'node:crypto';

export const ALGORITHM = 'minhash-sha256-8-v1';
const ROWS = 8;

export type SetId = 'a' | 'b';
type Slot = string | null;
export type Slots = readonly Slot[];
export type Signature = {id: SetId; algorithm: typeof ALGORITHM; slots: Slots};
export type Similarity = {algorithm: typeof ALGORITHM; matches: number; similarity: number; unionSlots: Slots};

export function emptySlots(): Slots {
  return Array<null>(ROWS).fill(null);
}

function minimum(a: Slot, b: Slot): Slot {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

export function addValue(slots: Slots, value: string): {changed: boolean; slots: Slots} {
  const updated = slots.map((previous, row) => {
    const priority = createHash('sha256').update(`${row}:${value}`, 'utf8').digest('hex');
    return minimum(previous, priority);
  });
  return {changed: updated.some((slot, row) => slot !== slots[row]), slots: updated};
}

export function mergeSlots(a: Slots, b: Slots): Slots {
  return a.map((slot, row) => minimum(slot, b[row] ?? null));
}

export function compareSlots(a: Slots, b: Slots): Similarity {
  // All-null signatures naturally give 8 matches against each other and 0 against any full signature.
  const matches = a.filter((slot, row) => slot === b[row]).length;
  return {algorithm: ALGORITHM, matches, similarity: matches / ROWS, unionSlots: mergeSlots(a, b)};
}

function hasFields(body: unknown, fields: readonly string[]): body is Record<string, unknown> {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).length === fields.length && fields.every(field => Object.hasOwn(body, field));
}

export function validValueBody(body: unknown): body is {value: string} {
  return hasFields(body, ['value']) && typeof body.value === 'string'
    && /^v(?:0|[1-9][0-9]{0,2})$/.test(body.value) && Number(body.value.slice(1)) <= 255;
}

function validSlots(value: unknown): value is Slots {
  if (!Array.isArray(value) || value.length !== ROWS) return false;
  const slots: readonly unknown[] = value;
  const empty = slots[0] === null;
  for (const slot of slots) {
    if (empty ? slot !== null : typeof slot !== 'string' || !/^[0-9a-f]{64}$/.test(slot)) return false;
  }
  return true;
}

export function validSignature(body: unknown, id: SetId): body is Signature {
  return hasFields(body, ['id', 'algorithm', 'slots']) && body.id === id
    && body.algorithm === ALGORITHM && validSlots(body.slots);
}
