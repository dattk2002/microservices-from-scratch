import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from '../../lib/http.mts';

export type Grant = {holder: string; generation: number; expiresAt: number};
export type Receipt = {generation: number; duplicate: boolean; applied: number};
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function object(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new HttpError(400, 'invalid', 'Expected object');
  return value;
}
export function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new HttpError(400, 'invalid', 'Expected bounded integer');
  return value;
}
export function identity(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,48}$/.test(value)) throw new HttpError(400, 'invalid', 'Expected ASCII identity, 1..48 characters');
  return value;
}
export function payload(value: unknown): string {
  if (typeof value !== 'string' || value.length > 256 || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)) throw new HttpError(400, 'invalid', 'Expected well-formed string, at most 256 UTF-16 units');
  return value;
}
export function grant(value: unknown): Grant {
  const row = object(value);
  return {holder: identity(row.holder), generation: integer(row.generation, 1), expiresAt: integer(row.expiresAt, 0)};
}
export function receipt(value: unknown): Receipt {
  const row = object(value);
  if (typeof row.duplicate !== 'boolean') throw new HttpError(502, 'upstream', 'Invalid receipt');
  return {generation: integer(row.generation, 1), duplicate: row.duplicate, applied: integer(row.applied, 1, 128)};
}
function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
export class LeaseStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  constructor(db: DatabaseSync, now: () => number) {
    this.db = db; this.now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS leadership (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), holder TEXT NOT NULL,
      generation INTEGER NOT NULL, expiresAt INTEGER NOT NULL);
      INSERT OR IGNORE INTO leadership VALUES(1,'',0,0)`);
  }
  acquire(holder: string, ttl: number): Grant | null {
    identity(holder); integer(ttl, 1, 10000);
    return transaction(this.db, () => {
      const now = integer(this.now(), 0, Number.MAX_SAFE_INTEGER - 10000);
      const old = object(this.db.prepare('SELECT generation, expiresAt FROM leadership WHERE singleton=1').get());
      if (integer(old.expiresAt, 0) > now) return null;
      const generation = integer(old.generation, 0, Number.MAX_SAFE_INTEGER - 1) + 1;
      const result = {holder, generation, expiresAt: now + ttl};
      this.db.prepare('UPDATE leadership SET holder=?, generation=?, expiresAt=? WHERE singleton=1').run(holder, generation, result.expiresAt);
      return result;
    });
  }
  renew(holder: string, generation: number, ttl: number): Grant | null {
    identity(holder); integer(generation, 1); integer(ttl, 1, 10000);
    return transaction(this.db, () => {
      const now = integer(this.now(), 0, Number.MAX_SAFE_INTEGER - 10000);
      const expiresAt = now + ttl;
      const updated = this.db.prepare(`UPDATE leadership SET expiresAt=?
        WHERE singleton=1 AND holder=? AND generation=? AND expiresAt>?`).run(expiresAt, holder, generation, now);
      return updated.changes === 1 ? {holder, generation, expiresAt} : null;
    });
  }
  release(holder: string, generation: number): boolean {
    identity(holder); integer(generation, 1);
    const now = integer(this.now(), 0);
    return this.db.prepare(`UPDATE leadership SET holder='', expiresAt=0
      WHERE singleton=1 AND holder=? AND generation=? AND expiresAt>?`).run(holder, generation, now).changes === 1;
  }
}
export class FencedSink {
  private readonly db: DatabaseSync;
  private readonly capacity: number;
  constructor(db: DatabaseSync, capacity = 128) {
    this.db = db; this.capacity = integer(capacity, 1, 128);
    db.exec(`CREATE TABLE IF NOT EXISTS fence(singleton INTEGER PRIMARY KEY CHECK(singleton=1), generation INTEGER NOT NULL);
      INSERT OR IGNORE INTO fence VALUES(1,0);
      CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY, payload TEXT NOT NULL)`);
  }
  write(generation: number, id: string, value: string): Receipt {
    integer(generation, 1); identity(id); payload(value);
    return transaction(this.db, () => {
      const highest = integer(object(this.db.prepare('SELECT generation FROM fence WHERE singleton=1').get()).generation, 0);
      if (generation < highest) throw new HttpError(409, 'fenced', 'fenced: older generation');
      const previous = this.db.prepare('SELECT payload FROM receipts WHERE id=?').get(id);
      const applied = integer(object(this.db.prepare('SELECT count(*) AS count FROM receipts').get()).count, 0, 128);
      if (previous && object(previous).payload !== value) throw new HttpError(409, 'conflict', 'conflict: operation identity already bound');
      if (!previous && applied >= this.capacity) throw new HttpError(507, 'capacity', 'capacity: receipts full; no eviction');
      this.db.prepare('UPDATE fence SET generation=? WHERE singleton=1').run(generation);
      if (!previous) this.db.prepare('INSERT INTO receipts VALUES(?,?)').run(id, value);
      // The receipt row IS the durable effect (one accepted export record).
      return {generation, duplicate: previous !== undefined, applied: applied + (previous ? 0 : 1)};
    });
  }
}
