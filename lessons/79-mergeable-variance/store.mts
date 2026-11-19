import type { DatabaseSync } from 'node:sqlite';
import { algorithm, decodeSnapshot, fail, receiptLimit } from './protocol.mts';
import type { Event, Snapshot, SourceId } from './protocol.mts';
import { add, emptyMoments } from './statistics.mts';

export class MomentsStore {
  private readonly db: DatabaseSync;
  private readonly id: SourceId;

  constructor(db: DatabaseSync, id: SourceId) {
    this.db = db;
    this.id = id;

    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    this.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS moments (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          id TEXT NOT NULL CHECK (id IN ('a', 'b')),
          algorithm TEXT NOT NULL,
          n INTEGER NOT NULL,
          mean REAL NOT NULL,
          m2 REAL NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS receipts (
          id TEXT PRIMARY KEY,
          value INTEGER NOT NULL
        ) STRICT;
      `);
      const { n, mean, m2 } = emptyMoments;
      db.prepare(`
        INSERT INTO moments (singleton, id, algorithm, n, mean, m2)
        VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT (singleton) DO NOTHING
      `).run(id, algorithm, n, mean, m2);

      const snapshot = this.snapshot();
      if (db.prepare('SELECT count(*) AS total FROM receipts').get()?.total !== snapshot.n) {
        throw new Error('Receipt count does not match persisted moments');
      }
    });
  }

  accept({ id, value }: Event): { id: string; duplicate: boolean } {
    return this.transaction(() => {
      const receipt = this.db.prepare('SELECT value FROM receipts WHERE id = ?').get(id);
      if (receipt) {
        if (receipt.value !== value) fail(409, 'id_conflict');
        return { id, duplicate: true };
      }

      const current = this.snapshot();
      if (current.n >= receiptLimit) fail(429, 'capacity');

      const { n, mean, m2 } = add(current, value);
      this.db.prepare('UPDATE moments SET n = ?, mean = ?, m2 = ? WHERE singleton = 1').run(n, mean, m2);
      this.db.prepare('INSERT INTO receipts (id, value) VALUES (?, ?)').run(id, value);
      return { id, duplicate: false };
    });
  }

  snapshot(): Snapshot {
    const row = this.db.prepare('SELECT id, algorithm, n, mean, m2 FROM moments WHERE singleton = 1').get();
    if (row && row.id !== this.id) throw new Error('Moments identity mismatch');
    const snapshot = decodeSnapshot(row, this.id);
    if (!snapshot) throw new Error('Invalid persisted moments');
    return snapshot;
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
