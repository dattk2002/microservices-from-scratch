import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { fail, strongTag } from './protocol.mts';

export class ObjectStore {
  private readonly select: StatementSync;
  private readonly insert: StatementSync;

  constructor(db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS objects (
        id TEXT PRIMARY KEY CHECK (id GLOB 'o[0-7]'),
        bytes BLOB NOT NULL CHECK (length(bytes) BETWEEN 1 AND 128)
      ) STRICT;
    `);
    this.select = db.prepare('SELECT bytes FROM objects WHERE id = ?');
    this.insert = db.prepare('INSERT INTO objects (id, bytes) VALUES (?, ?) ON CONFLICT(id) DO NOTHING');
  }

  get(id: string): {bytes: Buffer; etag: string} | undefined {
    const row = this.select.get(id);
    if (row === undefined) return undefined;
    if (!(row.bytes instanceof Uint8Array)) fail(500, 'internal_error');
    const bytes = Buffer.from(row.bytes);
    return {bytes, etag: strongTag(bytes)};
  }

  put(id: string, text: string): {created: boolean; etag: string; size: number} {
    const bytes = Buffer.from(text, 'utf8');
    const {changes} = this.insert.run(id, bytes);
    const created = changes === 1;
    // A conflict can only refer to an existing immutable row. Replay compares
    // raw bytes, so equality does not depend on a hash collision assumption.
    if (!created) {
      const existing = this.get(id);
      if (existing === undefined) fail(500, 'internal_error');
      if (!existing.bytes.equals(bytes)) fail(409, 'immutable_conflict');
    }
    return {created, etag: strongTag(bytes), size: bytes.length};
  }
}
