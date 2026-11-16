import { HttpError } from '../../lib/http.mts';
export type Id = 'a' | 'b' | 'c';
export type Value = 'red' | 'blue';
export type Accepted = { ballot: number; value: Value };
export type State = { id: Id; promised: number; accepted: Accepted | null };
export type Reply = State & { ballot: number; ok: boolean };
export type Attempt = { ballot: number; requested: Value; value: Value | null; phase: 'preparing' | 'accepting' | 'chosen' };
export type Chosen = Attempt & { value: Value; phase: 'chosen' };
export type Origins = Record<Id, string>;
export const ids: readonly Id[] = ['a', 'b', 'c'];
export function fail(status: number, code: string): never { throw new HttpError(status, code, code); }
export function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function ballot(value: unknown, min = 1): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= 16;
}
export function color(value: unknown): value is Value { return value === 'red' || value === 'blue'; }
export function parseBallot(value: unknown): number { if (!ballot(value)) fail(400, 'invalid_body'); return value; }
export function parseValue(value: unknown): Value { if (!color(value)) fail(400, 'invalid_body'); return value; }
export function request(value: unknown, withValue: true): Accepted;
export function request(value: unknown, withValue: false): { ballot: number };
export function request(value: unknown, withValue: boolean): { ballot: number; value?: Value } {
  if (!exact(value, withValue ? ['ballot', 'value'] : ['ballot'])) fail(400, 'invalid_body');
  const b = parseBallot(value.ballot);
  return withValue ? { ballot: b, value: parseValue(value.value) } : { ballot: b };
}
export function accepted(value: unknown): value is Accepted | null {
  return value === null || (exact(value, ['ballot', 'value']) && ballot(value.ballot) && color(value.value));
}
export function state(value: unknown): value is State {
  return exact(value, ['id', 'promised', 'accepted']) && (value.id === 'a' || value.id === 'b' || value.id === 'c') &&
    ballot(value.promised, 0) && accepted(value.accepted) && (value.accepted === null || value.accepted.ballot <= value.promised);
}
export function attempt(value: unknown): value is Attempt {
  return exact(value, ['ballot', 'requested', 'value', 'phase']) && ballot(value.ballot) && color(value.requested) &&
    ((value.phase === 'preparing' && value.value === null) || ((value.phase === 'accepting' || value.phase === 'chosen') && color(value.value)));
}
export function reply(value: unknown, id: Id, b: number, path: '/prepare' | '/accept', adopted?: Value): value is Reply {
  if (!exact(value, ['id', 'ballot', 'promised', 'ok', 'accepted']) || value.id !== id || value.ballot !== b ||
    !ballot(value.promised, 0) || typeof value.ok !== 'boolean' || !accepted(value.accepted) ||
    (value.accepted !== null && value.accepted.ballot > value.promised)) return false;
  if (!value.ok) return value.promised > b;
  if (value.promised !== b) return false;
  return path === '/prepare' || (value.accepted !== null && value.accepted.ballot === b && value.accepted.value === adopted);
}
// No upstream status is blindly forwarded. The one known 409 is still schema checked.
export function semanticError(value: unknown): boolean {
  return exact(value, ['error']) && exact(value.error, ['code', 'message']) &&
    value.error.code === 'ballot_conflict' && value.error.message === 'ballot_conflict';
}
export function origins(a: unknown, b: unknown, c: unknown): Origins {
  function normalize(raw: unknown) {
    if (typeof raw !== 'string') throw new Error('A_ORIGIN/B_ORIGIN/C_ORIGIN required');
    const u = new URL(raw);
    if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.username || u.password || u.pathname !== '/' || u.search || u.hash)
      throw new Error('Expected a fixed 127.0.0.1 HTTP origin');
    return u.origin;
  }
  const result = { a: normalize(a), b: normalize(b), c: normalize(c) };
  if (new Set(Object.values(result)).size !== 3) throw new Error('Acceptor origins must be distinct');
  return result;
}
