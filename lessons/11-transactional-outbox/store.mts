import { DatabaseSync } from 'node:sqlite';

export function retryDelay(attempt: number): number { return Math.min(2000, 100 * 2 ** Math.min(attempt, 5)); }
export type Event = { id: string; quantity: number };
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, quantity INTEGER NOT NULL CHECK(quantity > 0));
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY REFERENCES orders(id), quantity INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY, quantity INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS inventory(singleton INTEGER PRIMARY KEY CHECK(singleton=1), total INTEGER NOT NULL);
      INSERT OR IGNORE INTO inventory VALUES(1,0);`);
  }
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  create(id: string, quantity: number): boolean {
    return this.transaction(() => {
      const old = this.db.prepare('SELECT quantity FROM orders WHERE id=?').get(id);
      if (old) { if (old.quantity !== quantity) throw new Error('conflict'); return false; }
      this.db.prepare('INSERT INTO orders VALUES(?,?)').run(id, quantity);
      this.db.prepare('INSERT INTO outbox(id,quantity) VALUES(?,?)').run(id, quantity);
      return true;
    });
  }
  next(now: number): (Event & { attempts: number }) | undefined {
    const row = this.db.prepare('SELECT id,quantity,attempts FROM outbox WHERE sent=0 AND next_at<=? ORDER BY rowid LIMIT 1').get(now);
    if (!row) return undefined;
    if (typeof row.id !== 'string' || typeof row.quantity !== 'number' || typeof row.attempts !== 'number') throw new Error('Invalid stored event');
    return { id: row.id, quantity: row.quantity, attempts: row.attempts };
  }
  failed(id: string, attempts: number, now: number) {
    this.db.prepare('UPDATE outbox SET attempts=attempts+1,next_at=? WHERE id=? AND sent=0').run(now + retryDelay(attempts), id);
  }
  delivered(id: string) { this.db.prepare('UPDATE outbox SET sent=1 WHERE id=?').run(id); }
  consume(id: string, quantity: number): boolean {
    return this.transaction(() => {
      const old = this.db.prepare('SELECT quantity FROM inbox WHERE id=?').get(id);
      if (old) { if (old.quantity !== quantity) throw new Error('conflict'); return false; }
      this.db.prepare('INSERT INTO inbox VALUES(?,?)').run(id, quantity);
      this.db.prepare('UPDATE inventory SET total=total+? WHERE singleton=1').run(quantity);
      return true;
    });
  }
  scalar(sql: string): number {
    const row = this.db.prepare(sql).get();
    if (!row || typeof row.n !== 'number') throw new Error('Invalid count');
    return row.n;
  }
  orders() { return this.scalar('SELECT count(*) AS n FROM orders'); }
  pending() { return this.scalar('SELECT count(*) AS n FROM outbox WHERE sent=0'); }
  total() { return this.scalar('SELECT total AS n FROM inventory WHERE singleton=1'); }
  close() { if (this.db.isOpen) this.db.close(); }
}
