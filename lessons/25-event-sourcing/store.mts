import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { cartId, decide, fail, integer, replay } from './model.mts';
import type { State } from './model.mts';
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=200;
      CREATE TABLE IF NOT EXISTS events(cart TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(cart,seq));
      CREATE TRIGGER IF NOT EXISTS immutable_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'immutable'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'immutable'); END;
      CREATE TABLE IF NOT EXISTS snapshots(cart TEXT PRIMARY KEY, state TEXT NOT NULL);`);
  }
  close() { this.db.close(); }
  history(id: string, after: number, limit: number) {
    cartId(id); integer(after, 0, 128); integer(limit, 1, 16);
    const row = this.db.prepare('SELECT COALESCE(MAX(seq),0) AS version FROM events WHERE cart=?').get(id);
    const version = Number(row?.version);
    const events = this.db.prepare('SELECT body FROM events WHERE cart=? AND seq>? ORDER BY seq LIMIT ?').all(id, after, limit).map(row => JSON.parse(String(row.body)) as unknown);
    return { version, events };
  }
  all(id: string): unknown[] {
    cartId(id);
    return this.db.prepare('SELECT body FROM events WHERE cart=? ORDER BY seq LIMIT 129').all(id).map(row => JSON.parse(String(row.body)) as unknown);
  }
  state(id: string): State {
    const events = this.all(id);
    const row = this.db.prepare('SELECT state FROM snapshots WHERE cart=?').get(id);
    if (row) {
      try {
        const candidate: unknown = JSON.parse(String(row.state));
        if (candidate && typeof candidate === 'object' && 'version' in candidate) {
          const version = integer(candidate.version, 1, events.length);
          const prefix = replay(events.slice(0, version));
          if (isDeepStrictEqual(candidate, prefix)) return replay(events.slice(version), prefix);
        }
      } catch { /* Derived snapshot is disposable. Full replay remains authoritative. */ }
    }
    return replay(events);
  }
  snapshot(id: string) {
    const state = replay(this.all(id));
    if (!state.version) fail(404, 'not_found');
    this.db.prepare('INSERT INTO snapshots VALUES(?,?) ON CONFLICT(cart) DO UPDATE SET state=excluded.state').run(id, JSON.stringify(state));
    return state;
  }
  append(id: string, expected: number, command: unknown): State {
    cartId(id); integer(expected, 0, 128);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const state = replay(this.all(id));
      if (state.version !== expected) fail(409, 'version_conflict');
      if (!state.version && Number(this.db.prepare('SELECT COUNT(DISTINCT cart) AS n FROM events').get()?.n) >= 100) fail(409, 'cart_limit');
      const event = decide(state, command);
      this.db.prepare('INSERT INTO events VALUES(?,?,?)').run(id, event.seq, JSON.stringify(event));
      this.db.exec('COMMIT');
      return replay([event], state);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
