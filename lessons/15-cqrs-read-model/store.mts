import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { conflict, parseEvent } from './protocol.mts';
import type { Event, Status } from './protocol.mts';
class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=500;');
  }
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { if (this.db.isOpen) this.db.close(); }
}
export class Orders extends Store {
  constructor(path: string) {
    super(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, version INTEGER NOT NULL, quantity INTEGER NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, eventId TEXT UNIQUE NOT NULL,
      orderId TEXT NOT NULL, version INTEGER NOT NULL, quantity INTEGER NOT NULL, status TEXT NOT NULL, occurredAt INTEGER NOT NULL,
      UNIQUE(orderId,version));`);
  }
  get(id: string) { return this.db.prepare('SELECT * FROM orders WHERE id=?').get(id); }
  command(id: string, expected: number, quantity: number, status: Status): Event {
    return this.transaction(() => {
      const previous = this.get(id);
      if ((previous?.version ?? 0) !== expected) conflict('version_conflict');
      const version = expected + 1;
      if (!Number.isSafeInteger(version)) conflict('version_exhausted');
      this.db.prepare(`INSERT INTO orders VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        version=excluded.version, quantity=excluded.quantity, status=excluded.status`).run(id, version, quantity, status);
      const eventId = randomUUID(); const occurredAt = Date.now();
      const inserted = this.db.prepare('INSERT INTO events(eventId,orderId,version,quantity,status,occurredAt) VALUES(?,?,?,?,?,?)')
        .run(eventId, id, version, quantity, status, occurredAt);
      return parseEvent({ seq: Number(inserted.lastInsertRowid), eventId, orderId: id, version, quantity, status, occurredAt });
    });
  }
  events(after: number): Event[] {
    return this.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT 10').all(after).map(parseEvent);
  }
}
export class Projection extends Store {
  constructor(path: string) {
    super(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS summaries(id TEXT PRIMARY KEY, version INTEGER NOT NULL, quantity INTEGER NOT NULL,
      status TEXT NOT NULL, sourceAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS summaries_status ON summaries(status,id);
      CREATE TABLE IF NOT EXISTS inbox(eventId TEXT PRIMARY KEY, seq INTEGER UNIQUE NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS progress(singleton INTEGER PRIMARY KEY CHECK(singleton=1), checkpoint INTEGER NOT NULL, appliedAt INTEGER, orderCount INTEGER NOT NULL, totalQuantity INTEGER NOT NULL);
      INSERT OR IGNORE INTO progress VALUES(1,0,NULL,0,0);`);
  }
  state() {
    const progress = this.db.prepare('SELECT checkpoint,appliedAt,orderCount,totalQuantity FROM progress WHERE singleton=1').get();
    if (!progress || typeof progress.checkpoint !== 'number' || typeof progress.orderCount !== 'number' || typeof progress.totalQuantity !== 'number') throw new Error('Invalid state');
    return { checkpoint: progress.checkpoint, appliedAt: progress.appliedAt, orderCount: progress.orderCount, totalQuantity: progress.totalQuantity };
  }

  get(id: string) { return this.db.prepare('SELECT * FROM summaries WHERE id=?').get(id); }
  apply(input: Event): 'applied' | 'duplicate' {
    const e = parseEvent(input); const payload = JSON.stringify(e);
    return this.transaction(() => {
      const old = this.db.prepare('SELECT payload FROM inbox WHERE eventId=? OR seq=?').all(e.eventId, e.seq);
      if (old.length) {
        if (old.length === 1 && old[0]?.payload === payload) return 'duplicate';
        conflict('event_conflict');
      }
      const checkpoint = this.state().checkpoint;
      if (e.seq <= checkpoint) conflict('stale_sequence');
      if (e.seq !== checkpoint + 1) conflict('sequence_gap');
      const current = this.get(e.orderId);
      const version = current?.version ?? 0;
      if (typeof version !== 'number') throw new Error('Invalid stored version');
      if (e.version <= version) conflict('stale_version');
      if (e.version !== version + 1) conflict('version_gap');
      this.db.prepare(`INSERT INTO summaries VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        version=excluded.version,quantity=excluded.quantity,status=excluded.status,sourceAt=excluded.sourceAt`)
        .run(e.orderId, e.version, e.quantity, e.status, e.occurredAt);
      this.db.prepare('INSERT INTO inbox VALUES(?,?,?)').run(e.eventId, e.seq, payload);
      const oldQuantity = current?.quantity ?? 0;
      if (typeof oldQuantity !== 'number') throw new Error('Invalid stored quantity');
      this.db.prepare(`UPDATE progress SET checkpoint=?,appliedAt=?,orderCount=orderCount+?,
        totalQuantity=totalQuantity+? WHERE singleton=1`).run(e.seq, Date.now(), current ? 0 : 1, e.quantity - oldQuantity);
      return 'applied';
    });
  }
}
