import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { HttpError, json } from '../../lib/http.mts';

export const ALGORITHM = 'hll-sha256-32-p4-v1';
export type SketchId = 'a' | 'b';
export type Snapshot = {id: SketchId; algorithm: string; registers: number[]};

export function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function validId(value: unknown): value is SketchId { return value === 'a' || value === 'b'; }
export function validValue(value: unknown): value is string {
  return typeof value === 'string' && /^v(?:0|[1-9][0-9]{0,2})$/.test(value)
    && Number(value.slice(1)) <= 255 && value === `v${Number(value.slice(1))}`;
}
export function validRegisters(value: unknown): value is number[] {
  return Array.isArray(value) && value.length === 16
    && Array.from(value).every((rank: unknown) => typeof rank === 'number' && Number.isInteger(rank) && rank >= 0 && rank <= 29);
}
export function validSnapshot(value: unknown, id: string): value is Snapshot {
  return exact(value, ['id', 'algorithm', 'registers']) && validId(value.id) && value.id === id
    && value.algorithm === ALGORITHM && validRegisters(value.registers);
}
export function wordPosition(word: number): {index: number; rank: number} {
  // clz32 counts the four masked high bits too. Low-28 all-zero naturally gives 29.
  return {index: word >>> 28, rank: Math.clz32(word & 0x0fffffff) - 3};
}
export function position(value: string): {index: number; rank: number} {
  return wordPosition(createHash('sha256').update(value, 'utf8').digest().readUInt32BE(0));
}
export function add(registers: number[], value: string): boolean {
  const {index, rank} = position(value);
  const old = registers[index];
  if (old === undefined) throw new Error('Missing register');
  if (rank <= old) return false;
  registers[index] = rank;
  return true;
}
export function merge(a: number[], b: number[]): number[] {
  if (!validRegisters(a) || !validRegisters(b)) throw new Error('Invalid registers');
  return a.map((rank, index) => Math.max(rank, b[index] ?? 0));
}
// Separate the threshold decision so the mathematically exact boundary is testable:
// integer registers give dyadic sums and cannot produce raw exactly 40.
export function smallRange(raw: number, zeros: number): number {
  return raw <= 40 && zeros > 0 ? 16 * Math.log(16 / zeros) : raw;
}
export function estimate(registers: number[]): number {
  if (!validRegisters(registers)) throw new Error('Invalid registers');
  const raw = 0.673 * 16 * 16 / registers.reduce((sum, rank) => sum + 2 ** (-rank), 0);
  return smallRange(raw, registers.filter(rank => rank === 0).length);
}
export function fail(status: number, code: string): never { throw new HttpError(status, code, code); }
export function replyError(res: ServerResponse, error: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  const status = error instanceof HttpError ? error.status : 500;
  const code = error instanceof HttpError ? error.code : 'internal_error';
  json(res, status, {error: {code, message: code}});
}
export function validateHost(host: unknown): void {
  if (host !== undefined && host !== '127.0.0.1') throw new Error('HOST must be 127.0.0.1');
}
export function normalizeOrigin(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port === '0'
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Expected a loopback HTTP origin');
  }
  return url.origin;
}
export function configuredOrigins(a: string, b: string, host: unknown, port: number): [string, string] {
  validateHost(host);
  const first = normalizeOrigin(a), second = normalizeOrigin(b);
  const self = new URL(`http://127.0.0.1:${port}`).origin;
  if (first === second || (port !== 0 && (first === self || second === self))) throw new Error('Origins must be distinct');
  return [first, second];
}
