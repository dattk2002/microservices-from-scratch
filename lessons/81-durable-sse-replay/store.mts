import type { DatabaseSync } from 'node:sqlite';
import { isEventPayload, MAX_EVENTS } from './contracts.mts';
import type { EventPayload, ReplayEvent } from './contracts.mts';
import { fail } from './errors.mts';

export class FeedStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
    this.#transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          sequence INTEGER PRIMARY KEY CHECK (sequence BETWEEN 1 AND ${MAX_EVENTS}),
          text TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS receipts (
          id TEXT PRIMARY KEY,
          sequence INTEGER NOT NULL UNIQUE REFERENCES events(sequence)
        ) STRICT;
      `);
    });
  }

  append({id, text}: EventPayload): {created: boolean; sequence: number} {
    return this.#transaction(() => {
      const existing = this.#db.prepare(`
        SELECT events.sequence, events.text
        FROM receipts JOIN events USING (sequence)
        WHERE receipts.id = ?
      `).get(id);
      if (existing !== undefined) {
        if (typeof existing.sequence !== 'number') throw new Error('Invalid persisted receipt');
        if (existing.text !== text) fail(409, 'id_conflict');
        return {created: false, sequence: existing.sequence};
      }

      const row = this.#db.prepare('SELECT COALESCE(MAX(sequence), 0) AS tail FROM events').get();
      if (typeof row?.tail !== 'number') throw new Error('Invalid persisted tail');
      if (row.tail >= MAX_EVENTS) fail(429, 'capacity');
      const sequence = row.tail + 1;
      this.#db.prepare('INSERT INTO events (sequence, text) VALUES (?, ?)').run(sequence, text);
      this.#db.prepare('INSERT INTO receipts (id, sequence) VALUES (?, ?)').run(id, sequence);
      return {created: true, sequence};
    });
  }

  capture(after: number): ReplayEvent[] {
    // A single SELECT observes one committed SQLite snapshot. Materialise the bounded
    // result before writing any HTTP bytes so no read transaction survives the request.
    const rows = this.#db.prepare(`
      SELECT events.sequence, receipts.id, events.text
      FROM events LEFT JOIN receipts USING (sequence)
      ORDER BY events.sequence
    `).all();
    if (after > rows.length) fail(409, 'cursor_ahead');
    return rows.slice(after).map(({sequence, id, text}, index) => {
      const payload = {id, text};
      if (sequence !== after + index + 1 || !isEventPayload(payload)) {
        throw new Error('Invalid persisted event');
      }
      return {sequence, ...payload};
    });
  }

  #transaction<Result>(work: () => Result): Result {
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
}
