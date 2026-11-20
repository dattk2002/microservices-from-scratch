import type { DatabaseSync } from 'node:sqlite';
import { json } from '../../lib/http.mts';
import { etag, isProfile, MAX_VERSION, patchProfile } from './contract.mts';
import type { Revision } from './contract.mts';
import { runningDirectly, serveProfile } from './http.mts';
import type { Json } from './merge.mts';

function profiles(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      document TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version BETWEEN 0 AND 16)
    ) STRICT;
    INSERT INTO profile (id, document, version)
    VALUES (1, '{"name":"Ada","tags":[]}', 0) ON CONFLICT (id) DO NOTHING;
  `);
  const select = db.prepare('SELECT document, version FROM profile WHERE id = 1');
  const update = db.prepare('UPDATE profile SET document = ?, version = ? WHERE id = 1 AND version = ?');

  function read(): Revision {
    const row = select.get();
    if (!row || typeof row.document !== 'string' || typeof row.version !== 'number'
      || !Number.isInteger(row.version) || row.version < 0 || row.version > MAX_VERSION) {
      throw new Error('Invalid stored revision');
    }
    const profile: unknown = JSON.parse(row.document);
    if (!isProfile(profile)) throw new Error('Invalid stored profile');
    return { profile, version: row.version };
  }

  function patch(expected: number, patch: Json): Revision {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = read();
      const next = patchProfile(current, expected, patch);
      if (current !== next) {
        const result = update.run(JSON.stringify(next.profile), next.version, current.version);
        if (result.changes !== 1) throw new Error('Conditional update did not update one row');
      }
      db.exec('COMMIT');
      return next;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }

  return { read, patch };
}

async function main(): Promise<void> {
  const dbPath = process.env.DB_PATH;
  if (!dbPath) throw new Error('DB_PATH must name the store database');
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(dbPath);
  try {
    const profile = profiles(database);
    await serveProfile('store', 3089, (call, res) => {
      const revision = call.method === 'GET' ? profile.read() : profile.patch(call.version, call.patch);
      res.setHeader('etag', etag(revision.version));
      json(res, 200, revision.profile);
    });
  } finally {
    database.close();
  }
}

if (runningDirectly(import.meta.url)) await main();
