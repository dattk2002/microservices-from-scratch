import { DatabaseSync } from 'node:sqlite';
import { HttpError } from '../../lib/http.mts';
export type State = { id: string; version: number; value: string | null };
export function invalid(): never { throw new HttpError(400, 'invalid', 'Invalid bounded state'); }
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
export function parse(value: unknown): State {
  const x = object(value);
  if (typeof x.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(x.id) ||
      typeof x.version !== 'number' || !Number.isSafeInteger(x.version) || x.version < 1 ||
      !(x.value === null || typeof x.value === 'string' && x.value.length <= 256)) return invalid();
  return {id:x.id, version:x.version, value:x.value};
}
export function init(db: DatabaseSync) {
  db.exec('CREATE TABLE IF NOT EXISTS states (id TEXT PRIMARY KEY, version INTEGER NOT NULL, value TEXT)');
}
export function snapshot(db: DatabaseSync): State[] {
  init(db);
  return db.prepare('SELECT id, version, value FROM states ORDER BY id').all().map(parse);
}
export function apply(db: DatabaseSync, state: State): string {
  init(db);
  const old = snapshot(db).find(x => x.id === state.id);
  if (old) {
    if (old.version > state.version) return 'stale';
    if (old.version === state.version) return old.value === state.value ? 'duplicate' : 'conflict';
  } else if (snapshot(db).length >= 16) throw new HttpError(409, 'capacity', '16 identities including tombstones');
  db.prepare('INSERT INTO states VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET version=excluded.version, value=excluded.value').run(state.id, state.version, state.value);
  return 'applied';
}
export function parseSnapshot(value: unknown): State[] {
  if (!Array.isArray(value) || value.length > 16) return invalid();
  const records = value.map(parse);
  if (new Set(records.map(x => x.id)).size !== records.length) return invalid();
  return records;
}
