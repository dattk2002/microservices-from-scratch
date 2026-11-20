import type { DatabaseSync } from 'node:sqlite';
import { fail, parseSnapshot } from './contracts.mts';
import type { Snapshot } from './waiters.mts';

type Store = { read: () => Snapshot; advance: (value: number) => Snapshot | undefined };

export function prepareDocument(db: DatabaseSync): Store {
  db.exec(`
    CREATE TABLE IF NOT EXISTS document (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 16),
      value INTEGER NOT NULL CHECK (value BETWEEN 0 AND 100)
    ) STRICT;
    INSERT INTO document (id, revision, value) VALUES (1, 0, 0) ON CONFLICT (id) DO NOTHING;
  `);
  const select = db.prepare('SELECT revision, value FROM document WHERE id = 1');
  const update = db.prepare(`
    UPDATE document SET revision = revision + 1, value = ?
    WHERE id = 1 AND revision < 16 AND value <> ?
    RETURNING revision, value
  `);
  return {
    read: () => parseSnapshot(select.get()),
    advance(value) {
      // all() steps through SQLITE_DONE. The implicit transaction must commit before publishing.
      const [row] = update.all(value, value);
      return row === undefined ? undefined : parseSnapshot(row);
    },
  };
}

export function putDocument(store: Store, value: number, notify: () => void): Snapshot {
  const updated = store.advance(value);
  if (updated !== undefined) {
    notify();
    return updated;
  }

  // Only this process owns the database, and synchronous calls cannot interleave here.
  const current = store.read();
  if (current.value !== value) fail(409, 'revision_exhausted');
  return current;
}
