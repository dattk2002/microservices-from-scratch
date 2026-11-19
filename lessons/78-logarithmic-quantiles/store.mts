import type { DatabaseSync } from 'node:sqlite';
import { fail, MAX_RECEIPTS } from './contracts.mts';
import type { SampleEvent, Snapshot, SourceId } from './contracts.mts';
import { ALGORITHM, BIN_COUNT, binIndex } from './quantiles.mts';

export class HistogramStore {
  private readonly db: DatabaseSync;
  private readonly id: SourceId;

  constructor(db: DatabaseSync, id: SourceId) {
    this.db = db;
    this.id = id;
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    this.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS histogram_identity (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          source TEXT NOT NULL CHECK(source IN ('a', 'b'))
        ) STRICT;
        CREATE TABLE IF NOT EXISTS histogram_bins (
          bin INTEGER PRIMARY KEY CHECK(bin BETWEEN 0 AND ${BIN_COUNT - 1}),
          count INTEGER NOT NULL CHECK(count BETWEEN 0 AND ${MAX_RECEIPTS})
        ) STRICT;
        CREATE TABLE IF NOT EXISTS receipts (
          id TEXT PRIMARY KEY,
          value INTEGER NOT NULL CHECK(value BETWEEN 1 AND 1024)
        ) STRICT;
      `);
      const identity = db.prepare('SELECT source FROM histogram_identity WHERE singleton = 1').get();
      if (identity) {
        if (identity.source !== id) throw new Error('Histogram identity mismatch');
        return;
      }
      db.prepare('INSERT INTO histogram_identity VALUES (1, ?)').run(id);
      const initializeBin = db.prepare('INSERT INTO histogram_bins VALUES (?, 0)');
      for (let bin = 0; bin < BIN_COUNT; bin++) initializeBin.run(bin);
    });
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  record({ id, value }: SampleEvent): { id: string; duplicate: boolean } {
    return this.transaction(() => {
      const receipt = this.db.prepare('SELECT value FROM receipts WHERE id = ?').get(id);
      if (receipt) {
        if (receipt.value !== value) fail(409, 'id_conflict');
        return { id, duplicate: true };
      }

      const total = this.db.prepare('SELECT COUNT(*) AS total FROM receipts').get()?.total;
      if (typeof total !== 'number') throw new Error('Missing receipt count');
      if (total >= MAX_RECEIPTS) fail(429, 'capacity');
      this.db.prepare('INSERT INTO receipts (id, value) VALUES (?, ?)').run(id, value);
      const updated = this.db.prepare('UPDATE histogram_bins SET count = count + 1 WHERE bin = ?').run(binIndex(value));
      if (updated.changes !== 1) throw new Error('Missing persisted histogram bin');
      return { id, duplicate: false };
    });
  }

  snapshot(): Snapshot {
    const rows = this.db.prepare('SELECT bin, count FROM histogram_bins ORDER BY bin').all();
    if (rows.length !== BIN_COUNT) throw new Error('Missing persisted histogram bins');
    const bins = rows.map((row, index) => {
      if (row.bin !== index || typeof row.count !== 'number') throw new Error('Invalid persisted histogram bin');
      return row.count;
    });
    return { id: this.id, algorithm: ALGORITHM, total: bins.reduce((sum, count) => sum + count, 0), bins };
  }
}
