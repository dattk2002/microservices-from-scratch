import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
export type Job = { id: string; n: number; fail: number; state: string; attempt: number; token: string; lease: number; result: number | null; error: string | null };
export class Store {
  readonly db: DatabaseSync;
  readonly capacity: number; readonly attempts: number; readonly leaseMs: number; readonly clock: () => number;
  constructor(path: string, capacity = 100, attempts = 3, leaseMs = 2000, clock: () => number = Date.now) {
    this.capacity = capacity; this.attempts = attempts; this.leaseMs = leaseMs; this.clock = clock;
    for (const v of [capacity, attempts, leaseMs]) if (!Number.isSafeInteger(v) || v < 1 || v > 100000) throw new Error('invalid setting');
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,n INTEGER NOT NULL,fail INTEGER NOT NULL,state TEXT NOT NULL,
      attempt INTEGER NOT NULL,token TEXT NOT NULL,lease INTEGER NOT NULL,result INTEGER,error TEXT)`);
  }
  close() { this.db.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  admit(n: number, fail: boolean): string {
    if (!Number.isSafeInteger(n) || n < 0 || n > 10000 || typeof fail !== 'boolean') throw new Error('input');
    return this.transaction(() => {
      const count = this.db.prepare('SELECT count(*) AS total FROM jobs').get();
      if (Number(count?.total) >= this.capacity) throw new Error('capacity');
      const id = randomUUID();
      this.db.prepare("INSERT INTO jobs VALUES(?,?,?,'queued',0,'',0,NULL,NULL)").run(id, n, Number(fail));
      return id;
    });
  }
  get(id: string): Job | undefined {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    if (!row) return undefined;
    // Decode SQLite output explicitly; no unchecked row cast.
    return { id: String(row.id), n: Number(row.n), fail: Number(row.fail), state: String(row.state), attempt: Number(row.attempt), token: String(row.token), lease: Number(row.lease), result: row.result === null ? null : Number(row.result), error: row.error === null ? null : String(row.error) };
  }
  claim(): Job | undefined {
    return this.transaction(() => {
      const now = this.clock();
      this.db.prepare("UPDATE jobs SET state='failed',error='attempts_exhausted' WHERE state='running' AND lease<=? AND attempt>=?").run(now, this.attempts);
      const row = this.db.prepare("SELECT id FROM jobs WHERE state='queued' OR (state='running' AND lease<=? AND attempt<?) ORDER BY rowid LIMIT 1").get(now, this.attempts);
      if (!row) return undefined;
      const id = String(row.id);
      this.db.prepare("UPDATE jobs SET state='running',attempt=attempt+1,token=?,lease=? WHERE id=?").run(randomUUID(), now + this.leaseMs, id);
      return this.get(id);
    });
  }
  finish(id: string, token: string, success: boolean, result?: number): boolean {
    return this.transaction(() => {
      const job = this.get(id);
      if (!job || job.state !== 'running' || job.token !== token || job.lease <= this.clock()) return false;
      if (success && result !== job.n * (job.n + 1) / 2) return false;
      const state = success ? 'succeeded' : job.attempt >= this.attempts ? 'failed' : 'queued';
      // Recompute this cheap formula to validate the worker result at the owner boundary.
      this.db.prepare('UPDATE jobs SET state=?,result=?,error=? WHERE id=?').run(state, success ? job.n * (job.n + 1) / 2 : null, success ? null : 'computation_failed', id);
      return true;
    });
  }
}
