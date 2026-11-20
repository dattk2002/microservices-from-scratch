import type { DatabaseSync } from 'node:sqlite';
import type { Receipt } from './digest.mts';

export function prepareReceipts(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS receipt (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      bytes INTEGER NOT NULL CHECK (bytes BETWEEN 0 AND 1024),
      sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*')
    ) STRICT
  `);
  const select = db.prepare('SELECT bytes, sha256 FROM receipt WHERE id = 1');
  const upsert = db.prepare(`
    INSERT INTO receipt (id, bytes, sha256) VALUES (1, ?, ?)
    ON CONFLICT (id) DO UPDATE SET bytes = excluded.bytes, sha256 = excluded.sha256
  `);

  return {
    read(): Receipt | undefined {
      const row = select.get();
      if (!row) return undefined;
      const {bytes, sha256} = row;
      if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0 || bytes > 1024
        || typeof sha256 !== 'string' || sha256.length !== 64 || !/^[0-9a-f]+$/.test(sha256)) {
        throw new Error('Invalid receipt row');
      }
      return {bytes, sha256};
    },
    commit({bytes, sha256}: Receipt): void {
      // A single autocommit statement. run() returns after the write has finished.
      upsert.run(bytes, sha256);
    },
  };
}
