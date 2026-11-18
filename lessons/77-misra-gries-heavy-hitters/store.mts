import type { DatabaseSync } from 'node:sqlite';
import { fail, MAX_EVENTS, parseSummary } from './protocol.mts';
import type { Event } from './protocol.mts';
import { addKey } from './summary.mts';
import type { Source, Summary } from './summary.mts';

export class StreamStore {
  readonly #db: DatabaseSync;
  readonly #id: Source;

  constructor(db: DatabaseSync, id: Source) {
    this.#db = db;
    this.#id = id;
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS summary (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        stream_id TEXT NOT NULL CHECK (stream_id IN ('a', 'b')),
        total INTEGER NOT NULL CHECK (total BETWEEN 0 AND 64),
        dropped INTEGER NOT NULL CHECK (dropped BETWEEN 0 AND 16),
        counters TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS receipts (
        id TEXT PRIMARY KEY NOT NULL,
        event_key TEXT NOT NULL
      ) STRICT;
    `);
    this.#transaction(() => {
      db.prepare(`INSERT INTO summary VALUES (1, ?, 0, 0, '[]')
        ON CONFLICT (singleton) DO NOTHING`).run(id);
      this.summary();
    });
  }

  #transaction<T>(work: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  summary(): Summary {
    const row = this.#db.prepare('SELECT stream_id, total, dropped, counters FROM summary WHERE singleton = 1').get();
    if (!row || typeof row.counters !== 'string') throw new Error('Missing stream summary');
    if (row.stream_id !== this.#id) throw new Error('Stream identity mismatch');
    const counters: unknown = JSON.parse(row.counters);
    const parsed = parseSummary({
      id: row.stream_id, algorithm: 'mg3-v1', total: row.total, dropped: row.dropped, counters,
    }, this.#id);
    if (!parsed) throw new Error('Invalid stored stream summary');
    return parsed;
  }

  append(event: Event): { id: string; duplicate: boolean } {
    return this.#transaction(() => {
      const receipt = this.#db.prepare('SELECT event_key FROM receipts WHERE id = ?').get(event.id);
      if (receipt) {
        if (receipt.event_key !== event.key) fail(409, 'id_conflict');
        return { id: event.id, duplicate: true };
      }
      const current = this.summary();
      if (current.total >= MAX_EVENTS) fail(429, 'capacity');

      const next = addKey(current, event.key);
      this.#db.prepare('INSERT INTO receipts (id, event_key) VALUES (?, ?)').run(event.id, event.key);
      this.#db.prepare('UPDATE summary SET total = ?, dropped = ?, counters = ? WHERE singleton = 1')
        .run(next.total, next.dropped, JSON.stringify(next.counters));
      return { id: event.id, duplicate: false };
    });
  }
}
