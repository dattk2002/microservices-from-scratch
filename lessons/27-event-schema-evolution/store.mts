import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { envelope, fail, stable, upcast } from './model.mts';
export class History {
 private db: DatabaseSync;
 constructor(path: string) {
  this.db = new DatabaseSync(path);
  this.db.exec(`PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS events(position INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, raw TEXT NOT NULL);
   CREATE TRIGGER IF NOT EXISTS immutable_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'immutable'); END;
   CREATE TRIGGER IF NOT EXISTS immutable_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'immutable'); END;`);
 }
 append(value: unknown, teaching = false) {
  const e = envelope(value); if (!teaching) upcast(e);
  this.db.exec('BEGIN IMMEDIATE');
  try {
   const n = Number(this.db.prepare('SELECT count(*) n FROM events').get()?.n);
   if (n >= 100) fail('retention_full');
   if (e.position !== n + 1) fail('source_gap');
   if (this.db.prepare('SELECT id FROM events WHERE id=?').get(e.id)) fail('identity_conflict');
   this.db.prepare('INSERT INTO events VALUES(?,?,?)').run(e.position, e.id, JSON.stringify(e));
   this.db.exec('COMMIT'); return e;
  } catch (e) { this.db.exec('ROLLBACK'); throw e; }
 }
 page(after: number) { return this.db.prepare('SELECT raw FROM events WHERE position>? ORDER BY position LIMIT 10').all(after).map(r => JSON.parse(String(r.raw)) as unknown); }
 close() { this.db.close(); }
}
export class Projection {
 private db: DatabaseSync;
 constructor(path: string) {
  this.db = new DatabaseSync(path);
  this.db.exec(`PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS effects(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, amount INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS progress(singleton INTEGER PRIMARY KEY CHECK(singleton=1), position INTEGER NOT NULL);
   INSERT OR IGNORE INTO progress VALUES(1,0);`);
 }
 state() { return { checkpoint: Number(this.db.prepare('SELECT position FROM progress').get()?.position), totalMinor: Number(this.db.prepare('SELECT coalesce(sum(amount),0) n FROM effects').get()?.n), count: Number(this.db.prepare('SELECT count(*) n FROM effects').get()?.n) }; }
 apply(value: unknown, supported = 'current') {
  const e = envelope(value); const c = upcast(e, supported);
  const fingerprint = createHash('sha256').update(stable(e)).digest('hex');
  this.db.exec('BEGIN IMMEDIATE');
  try {
   const seen = this.db.prepare('SELECT fingerprint FROM effects WHERE id=?').get(e.id);
   if (seen && seen.fingerprint !== fingerprint) fail('identity_conflict');
   if (seen) { this.db.exec('COMMIT'); return false; }
   if (e.position !== this.state().checkpoint + 1) fail('source_gap');
   this.db.prepare('INSERT INTO effects VALUES(?,?,?)').run(e.id, fingerprint, c.amountMinor);
   this.db.prepare('UPDATE progress SET position=?').run(e.position);
   this.db.exec('COMMIT'); return true;
  } catch (e) { this.db.exec('ROLLBACK'); throw e; }
 }
 close() { this.db.close(); }
}
