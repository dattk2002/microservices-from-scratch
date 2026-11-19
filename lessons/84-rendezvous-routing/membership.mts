import type { DatabaseSync } from 'node:sqlite';
import type { Member } from './placement.mts';
import { exact, fail, isMember } from './protocol.mts';

const MAX_REVISION = 16;

type Snapshot = { revision: number; members: readonly Member[] };

function canonicalMembers(value: unknown): Member[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) return undefined;
  const input: readonly unknown[] = value;
  const members: Member[] = [];
  for (const member of input) {
    if (!isMember(member) || members.includes(member)) return undefined;
    members.push(member);
  }
  return members.sort();
}

export class MembershipStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS membership (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 16),
        members TEXT NOT NULL CHECK (members IN ('a', 'b', 'c', 'a,b', 'a,c', 'b,c', 'a,b,c'))
      ) STRICT;
      INSERT OR IGNORE INTO membership VALUES (1, 0, 'a,b,c');
    `);
  }

  read(): Snapshot {
    const row = this.#db.prepare('SELECT revision, members FROM membership WHERE singleton = 1').get();
    if (!row || typeof row.revision !== 'number' || typeof row.members !== 'string') {
      throw new Error('Missing membership snapshot');
    }
    const members = canonicalMembers(row.members.split(','));
    if (!members) throw new Error('Invalid stored membership');
    return { revision: row.revision, members };
  }

  update(body: unknown): Snapshot {
    const members = exact(body, ['members']) ? canonicalMembers(body.members) : undefined;
    if (!members) fail(400, 'invalid_membership');
    const encoded = members.join(',');

    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.read();
      let snapshot = current;
      if (current.members.join(',') !== encoded) {
        if (current.revision === MAX_REVISION) fail(409, 'revision_exhausted');
        snapshot = { revision: current.revision + 1, members };
        this.#db.prepare('UPDATE membership SET revision = ?, members = ? WHERE singleton = 1')
          .run(snapshot.revision, encoded);
      }
      this.#db.exec('COMMIT');
      return snapshot;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
}
