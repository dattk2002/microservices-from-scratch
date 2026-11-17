import type { DatabaseSync } from 'node:sqlite';
import type { Identity, Snapshot } from './protocol.mts';
import { identity, emptyCells, event, increment, validSnapshot, semantic } from './protocol.mts';

// The process owns the connection. A snapshot is read from one SQLite row; a
// receipt and its complete matrix update share one synchronous transaction.
export class SketchStore {
  private readonly db: DatabaseSync;
  private readonly id: Identity;

  constructor(db: DatabaseSync, id: Identity) {
    if (!identity(id)) throw new Error('SKETCH_ID must be a or b');
    this.db = db; this.id = id;
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=100');
    this.transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS sketch (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        identity TEXT NOT NULL CHECK(identity IN ('a','b')),
        version INTEGER NOT NULL CHECK(version BETWEEN 0 AND 64),
        total INTEGER NOT NULL CHECK(total BETWEEN version AND 9*version),
        cells TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS receipts (
        id TEXT PRIMARY KEY NOT NULL, key TEXT NOT NULL,
        weight INTEGER NOT NULL CHECK(weight BETWEEN 1 AND 9)
      ) STRICT`);
      db.prepare('INSERT OR IGNORE INTO sketch VALUES(1,?,0,0,?)').run(id, JSON.stringify(emptyCells()));
      const saved = db.prepare('SELECT identity FROM sketch WHERE singleton=1').get();
      if (saved?.identity !== id) throw new Error('Sketch identity mismatch');
      this.snapshot();
    });
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  snapshot(): Snapshot {
    const row = this.db.prepare('SELECT identity, version, total, cells FROM sketch WHERE singleton=1').get();
    if (typeof row?.cells !== 'string') throw new Error('Missing sketch state');
    const cells: unknown = JSON.parse(row.cells);
    const snapshot = { id: row.identity, version: row.version, total: row.total, cells };
    if (!validSnapshot(snapshot, this.id)) throw new Error('Corrupt sketch state');
    return snapshot;
  }

  accept(body: unknown): { id: string; duplicate: boolean } {
    const accepted = event(body);
    return this.transaction(() => {
      const saved = this.db.prepare('SELECT key, weight FROM receipts WHERE id=?').get(accepted.id);
      if (saved) {
        if (saved.key !== accepted.key || saved.weight !== accepted.weight) semantic(409, 'id_conflict');
        return { id: accepted.id, duplicate: true };
      }
      const state = this.snapshot();
      if (state.version === 64) semantic(429, 'capacity');
      increment(state.cells, accepted.key, accepted.weight);
      // A failure of the second statement must roll back this first statement too.
      this.db.prepare('INSERT INTO receipts VALUES(?,?,?)').run(accepted.id, accepted.key, accepted.weight);
      this.db.prepare('UPDATE sketch SET version=?, total=?, cells=? WHERE singleton=1')
        .run(state.version + 1, state.total + accepted.weight, JSON.stringify(state.cells));
      return { id: accepted.id, duplicate: false };
    });
  }
}
