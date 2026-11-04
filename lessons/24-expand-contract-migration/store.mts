import { DatabaseSync } from 'node:sqlite';

export type Version = 'old' | 'new';
type Phase = 'original' | 'expanded' | 'ready' | 'contracted';
export class Conflict extends Error {}
export class Catalog {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(`PRAGMA busy_timeout=1000;
        CREATE TABLE IF NOT EXISTS migration (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1),
          phase TEXT NOT NULL, cursor INTEGER NOT NULL, retired INTEGER NOT NULL);
        INSERT OR IGNORE INTO migration VALUES(1,'original',0,0);
        CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY, legacy_name TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS admissions (
          ticket INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL,
          name TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0);
      `);
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  private tx<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  status(): {phase: Phase; cursor: number; retired: boolean; pending: number} {
    const row = this.db.prepare('SELECT * FROM migration').get();
    const phase = row?.phase;
    if (phase !== 'original' && phase !== 'expanded' && phase !== 'ready' && phase !== 'contracted') throw new Error('Corrupt phase');
    return {phase, cursor: Number(row?.cursor), retired: row?.retired === 1,
      pending: Number(this.db.prepare('SELECT count(*) AS n FROM admissions WHERE done=0').get()?.n)};
  }
  private compatible(version: Version) {
    if (version === 'old' && this.status().phase === 'contracted') throw new Conflict('contract: old binary incompatible');
  }
  private put(version: Version, id: number, name: string) {
    const phase = this.status().phase;
    this.compatible(version);
    const column = phase === 'contracted' ? 'display_name' : 'legacy_name';
    this.db.prepare(`INSERT INTO products(id,${column}) VALUES(?,?)
      ON CONFLICT(id) DO UPDATE SET ${column}=excluded.${column}`).run(id, name);
  }
  write(version: Version, id: number, name: string) {
    this.validate(id, name);
    if (version === 'old') { const ticket = this.admit(id, name); this.complete(ticket); }
    else this.tx(() => this.put(version, id, name));
  }
  private validate(id: number, name: string) {
    if (!Number.isSafeInteger(id) || id < 1 || typeof name !== 'string' || !name.trim() || name.length > 100) throw new Error('Invalid product');
  }
  admit(id: number, name: string): number {
    this.validate(id, name);
    return this.tx(() => {
      this.compatible('old');
      const s = this.status();
      if (s.retired) throw new Conflict('old writer retired');
      if (s.pending >= 32) throw new Conflict('admission capacity');
      return Number(this.db.prepare('INSERT INTO admissions(product_id,name) VALUES(?,?)').run(id, name).lastInsertRowid);
    });
  }
  complete(ticket: number): number {
    return this.tx(() => {
      this.compatible('old');
      const row = this.db.prepare('SELECT * FROM admissions WHERE ticket=?').get(ticket);
      if (!row) throw new Conflict('unknown ticket');
      if (row.done === 0) {
        if (typeof row.name !== 'string') throw new Error('Corrupt admission');
        this.put('old', Number(row.product_id), row.name);
        this.db.prepare('UPDATE admissions SET done=1 WHERE ticket=?').run(ticket);
      }
      return Number(row.product_id);
    });
  }
  read(version: Version, id: number): string | undefined {
    // A short read transaction pins phase and schema together across DDL.
    return this.tx(() => {
      this.compatible(version);
      const phase = this.status().phase;
      const column = version === 'old' || phase === 'original' ? 'legacy_name'
        : phase === 'contracted' ? 'display_name' : 'COALESCE(display_name,legacy_name)';
      const value = this.db.prepare(`SELECT ${column} AS name FROM products WHERE id=?`).get(id)?.name;
      return typeof value === 'string' ? value : undefined;
    });
  }
  expand() {
    this.tx(() => {
      if (this.status().phase !== 'original') throw new Conflict('phase: expand requires original');
      this.db.exec(`ALTER TABLE products ADD COLUMN display_name TEXT;
        CREATE TRIGGER sync_insert AFTER INSERT ON products BEGIN
          UPDATE products SET display_name=NEW.legacy_name WHERE id=NEW.id;
        END;
        CREATE TRIGGER sync_update AFTER UPDATE OF legacy_name ON products BEGIN
          UPDATE products SET display_name=NEW.legacy_name WHERE id=NEW.id;
        END;
        UPDATE migration SET phase='expanded';`);
    });
  }
  batch(size: number, interrupt = false) {
    if (!Number.isSafeInteger(size) || size < 1 || size > 100) throw new Error('batch must be 1..100');
    return this.tx(() => {
      const s = this.status();
      if (s.phase !== 'expanded') throw new Conflict('phase: batch requires expanded');
      const rows = this.db.prepare('SELECT id FROM products WHERE id>? ORDER BY id LIMIT ?').all(s.cursor, size);
      for (const row of rows) this.db.prepare('UPDATE products SET display_name=legacy_name WHERE id=?').run(row.id!);
      const cursor = rows.length ? Number(rows.at(-1)?.id) : s.cursor;
      this.db.prepare('UPDATE migration SET cursor=?,phase=?').run(cursor, rows.length < size ? 'ready' : 'expanded');
      if (interrupt) throw new Error('interrupted before commit');
      return this.status();
    });
  }
  copied() { return Number(this.db.prepare('SELECT count(*) AS n FROM products WHERE display_name IS NOT NULL').get()?.n); }
  retire() {
    this.tx(() => {
      if (this.status().phase !== 'ready') throw new Conflict('phase: retire requires ready');
      // The gate and the durable commands share SQLite's single-writer lock.
      this.db.exec('UPDATE migration SET retired=1');
      for (const row of this.db.prepare('SELECT * FROM admissions WHERE done=0 ORDER BY ticket LIMIT 32').all()) {
        if (typeof row.name !== 'string') throw new Error('Corrupt admission');
        this.put('old', Number(row.product_id), row.name);
      }
      this.db.exec('UPDATE admissions SET done=1 WHERE done=0');
    });
  }
  contract() {
    this.tx(() => {
      const s = this.status();
      if (s.phase !== 'ready') throw new Conflict('phase: contract requires ready');
      if (!s.retired || s.pending !== 0) throw new Conflict('retire and drain old writers first');
      if (this.db.prepare('SELECT id FROM products WHERE display_name IS NULL OR display_name<>legacy_name LIMIT 1').get()) throw new Conflict('incomplete migration');
      this.db.exec(`DROP TRIGGER sync_insert; DROP TRIGGER sync_update;
        ALTER TABLE products DROP COLUMN legacy_name;
        UPDATE migration SET phase='contracted';`);
    });
  }
}
