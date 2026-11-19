import type { DatabaseSync } from 'node:sqlite';
import { ALGORITHM, addValue, emptySlots, validSignature } from './model.mts';
import type { SetId, Signature } from './model.mts';

export class SignatureStore {
  private readonly db: DatabaseSync;
  private readonly id: SetId;

  constructor(db: DatabaseSync, id: SetId) {
    this.db = db;
    this.id = id;
    db.exec('PRAGMA synchronous=FULL');
    this.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS signature (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          id TEXT NOT NULL,
          algorithm TEXT NOT NULL,
          slots TEXT NOT NULL
        )
      `);
      db.prepare('INSERT INTO signature VALUES (1, ?, ?, ?) ON CONFLICT(singleton) DO NOTHING')
        .run(id, ALGORITHM, JSON.stringify(emptySlots()));
      this.snapshot();
    });
  }

  private transaction<Result>(work: () => Result): Result {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  snapshot(): Signature {
    const row = this.db.prepare('SELECT id, algorithm, slots FROM signature WHERE singleton = 1').get();
    if (typeof row?.slots !== 'string') throw new Error('Invalid persisted signature');
    if (row.id !== this.id) throw new Error('Set identity mismatch');
    if (row.algorithm !== ALGORITHM) throw new Error('Signature algorithm mismatch');
    const slots: unknown = JSON.parse(row.slots);
    const signature = {id: row.id, algorithm: row.algorithm, slots};
    if (!validSignature(signature, this.id)) throw new Error('Invalid persisted signature');
    return signature;
  }

  add(value: string): {changed: boolean} {
    return this.transaction(() => {
      const {changed, slots} = addValue(this.snapshot().slots, value);
      if (changed) this.db.prepare('UPDATE signature SET slots = ? WHERE singleton = 1').run(JSON.stringify(slots));
      return {changed};
    });
  }
}
