import { createHash } from 'node:crypto';
import { HttpError } from '../../lib/http.mts';

export type Identity = 'a' | 'b';
export type Cells = number[][];
export type Snapshot = { id: Identity; version: number; total: number; cells: Cells };
export type Event = { id: string; key: string; weight: number };

export function exact(body: unknown, fields: readonly string[]): body is Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    && Object.keys(body).length === fields.length && fields.every(field => Object.hasOwn(body, field));
}
export function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}
export function key(value: unknown): value is string {
  return typeof value === 'string' && /^k(?:[0-9]|[12][0-9]|3[01])$/.test(value);
}
export function identity(value: unknown): value is Identity { return value === 'a' || value === 'b'; }
export function semantic(status: number, code: string): never { throw new HttpError(status, code, code); }
export function invalid(): never { return semantic(400, 'invalid_request'); }
export function event(body: unknown): Event {
  if (!exact(body, ['id', 'key', 'weight']) || typeof body.id !== 'string' || !/^[a-z0-9]{1,16}$/.test(body.id)
    || !key(body.key) || !integer(body.weight, 1, 9)) invalid();
  return { id: body.id, key: body.key, weight: body.weight };
}

export function positions(key: string): [number, number, number] {
  const column = (row: number) => createHash('sha256').update(`${row}:${key}`, 'utf8').digest().readUInt32BE(0) % 16;
  return [column(0), column(1), column(2)];
}
export function emptyCells(): Cells { return Array.from({ length: 3 }, () => Array<number>(16).fill(0)); }
function cell(cells: Cells, row: number, column: number): number {
  const value = cells[row]?.[column];
  if (value === undefined) throw new Error('Missing sketch cell');
  return value;
}
// Internal matrix operations consume validated snapshots or freshly allocated matrices.
export function increment(cells: Cells, key: string, weight: number): void {
  for (const [row, column] of positions(key).entries()) {
    const line = cells[row];
    if (!line) throw new Error('Missing sketch row');
    line[column] = cell(cells, row, column) + weight;
  }
}
export function merge(a: Cells, b: Cells): Cells {
  return Array.from({ length: 3 }, (_, row) => Array.from({ length: 16 }, (_, column) => cell(a, row, column) + cell(b, row, column)));
}
export function estimate(cells: Cells, key: string): number {
  return Math.min(...positions(key).map((column, row) => cell(cells, row, column)));
}
export function validSnapshot(body: unknown, expected: Identity): body is Snapshot {
  if (!exact(body, ['id', 'version', 'total', 'cells']) || body.id !== expected
    || !integer(body.version, 0, 64) || !integer(body.total, 0, 576)
    || body.total < body.version || body.total > 9 * body.version
    || !Array.isArray(body.cells) || body.cells.length !== 3) return false;
  const total = body.total;
  return body.cells.every((row: unknown) => Array.isArray(row) && row.length === 16
    && row.every((value: unknown) => integer(value, 0, 576))
    && row.reduce((sum: number, value: number) => sum + value, 0) === total);
}
export function validateHost(host: unknown): void {
  if (host !== undefined && host !== '127.0.0.1') throw new Error('HOST must be 127.0.0.1');
}
