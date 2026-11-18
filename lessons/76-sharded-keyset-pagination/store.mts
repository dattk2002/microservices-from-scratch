import type { DatabaseSync } from 'node:sqlite';
import { exact, fail, invalid, isOwnedId, isScore, MAX_REVISION } from './protocol.mts';
import type { PageOptions, Shard, ShardPage } from './protocol.mts';

const MAX_SNAPSHOTS = 4;

export class ShardStore {
  private readonly db: DatabaseSync;
  private readonly shard: Shard;

  constructor(db: DatabaseSync, shard: Shard) {
    this.db = db;
    this.shard = shard;
    db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 1000;
      CREATE TABLE IF NOT EXISTS shard_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        shard TEXT NOT NULL CHECK (shard IN ('a', 'b')),
        revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 16)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS live_items (
        id TEXT PRIMARY KEY,
        score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS snapshots (revision INTEGER PRIMARY KEY) STRICT;
      CREATE TABLE IF NOT EXISTS snapshot_items (
        revision INTEGER NOT NULL REFERENCES snapshots (revision),
        id TEXT NOT NULL,
        score INTEGER NOT NULL,
        PRIMARY KEY (revision, id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS snapshot_order ON snapshot_items (revision, score DESC, id ASC);
    `);
    this.transaction(() => {
      const identity = db.prepare('SELECT shard FROM shard_meta WHERE singleton = 1').get();
      if (identity) {
        if (identity.shard !== shard) throw new Error('Shard identity mismatch');
      } else {
        db.prepare('INSERT INTO shard_meta VALUES (1, ?, 0)').run(shard);
        db.exec('INSERT INTO snapshots VALUES (0)');
      }
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

  private liveRevision(): number {
    const revision = this.db.prepare('SELECT revision FROM shard_meta WHERE singleton = 1').get()?.revision;
    if (typeof revision !== 'number') throw new Error('Missing live revision');
    return revision;
  }

  write(id: unknown, body: unknown): { revision: number } {
    if (!isOwnedId(id, this.shard) || !exact(body, ['score']) || !isScore(body.score)) invalid();
    const score = body.score;
    return this.transaction(() => {
      const revision = this.liveRevision();
      const current = this.db.prepare('SELECT score FROM live_items WHERE id = ?').get(id);
      if (current?.score === score) return { revision };
      if (revision === MAX_REVISION) fail(409, 'revision_exhausted');

      this.db.prepare(`
        INSERT INTO live_items (id, score) VALUES (?, ?)
        ON CONFLICT (id) DO UPDATE SET score = excluded.score
      `).run(id, score);
      this.db.prepare('UPDATE shard_meta SET revision = ? WHERE singleton = 1').run(revision + 1);
      return { revision: revision + 1 };
    });
  }

  publish(body: unknown): { revision: number } {
    if (!exact(body, [])) invalid();
    return this.transaction(() => {
      const revision = this.liveRevision();
      if (this.db.prepare('SELECT revision FROM snapshots WHERE revision = ?').get(revision)) return { revision };
      const capacity = this.db.prepare('SELECT COUNT(*) AS total FROM snapshots').get();
      if (capacity?.total === MAX_SNAPSHOTS) fail(429, 'snapshot_capacity');

      this.db.prepare('INSERT INTO snapshots VALUES (?)').run(revision);
      this.db.prepare('INSERT INTO snapshot_items SELECT ?, id, score FROM live_items').run(revision);
      return { revision };
    });
  }

  page(revision: number, { limit, after }: PageOptions): ShardPage {
    if (!this.db.prepare('SELECT revision FROM snapshots WHERE revision = ?').get(revision)) {
      fail(404, 'unknown_snapshot');
    }
    // A published revision is immutable, so the existence check and SELECT can be separate reads.
    const rows = this.db.prepare(`
      SELECT id, score FROM snapshot_items
      WHERE revision = :revision
        AND (:score IS NULL OR score < :score OR (score = :score AND id > :id))
      ORDER BY score DESC, id ASC
      LIMIT :limit
    `).all({ revision, limit, score: after?.score ?? null, id: after?.id ?? null });
    const items = rows.map(({ id, score }) => {
      if (!isOwnedId(id, this.shard) || !isScore(score)) throw new Error('Invalid stored item');
      return { id, score };
    });
    return { shard: this.shard, revision, items };
  }
}
