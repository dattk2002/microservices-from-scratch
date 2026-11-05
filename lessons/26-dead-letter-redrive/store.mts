import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from '../../lib/http.mts';

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'input', 'Expected object');
  return Object.fromEntries(Object.entries(value));
}
export function identity(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value)) throw new HttpError(400, 'id', 'Invalid id');
  return value;
}
export function payload(value: unknown): string {
  const p = object(value);
  if (Object.keys(p).sort().join(',') !== 'amount,format' || !Number.isSafeInteger(p.amount) || typeof p.amount !== 'number' || p.amount < 1 || p.amount > 1000 || (typeof p.format !== 'string' || !['current', 'legacy', 'transient'].includes(p.format))) {
    throw new HttpError(400, 'payload', 'Invalid payload');
  }
  return JSON.stringify({ amount: p.amount, format: p.format });
}
export type Message = { id: string; payload: string; state: string; attempts: number; cycleAttempts: number; redrives: number; token: string | null; until: number; reason: string | null };
function decode(value: unknown): Message {
  const r = object(value);
  if (typeof r.id !== 'string' || typeof r.payload !== 'string' || typeof r.state !== 'string' || typeof r.attempts !== 'number' || typeof r.cycleAttempts !== 'number' || typeof r.redrives !== 'number' || (r.token !== null && typeof r.token !== 'string') || typeof r.until !== 'number' || (r.reason !== null && typeof r.reason !== 'string')) throw new Error('Corrupt row');
  return { id: r.id, payload: r.payload, state: r.state, attempts: r.attempts, cycleAttempts: r.cycleAttempts, redrives: r.redrives, token: r.token, until: r.until, reason: r.reason };
}
export class Queue {
  private db: DatabaseSync;
  private now: () => number;
  private capacity: number;
  private lease: number;
  constructor(path: string, now = Date.now, capacity = 100, lease = 3000) {
    this.now = now; this.capacity = capacity; this.lease = lease;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,payload TEXT NOT NULL,state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,cycleAttempts INTEGER NOT NULL DEFAULT 0,redrives INTEGER NOT NULL DEFAULT 0,
      token TEXT,until INTEGER NOT NULL DEFAULT 0,reason TEXT);`);
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  admit(id: string, value: unknown) {
    identity(id); const data = payload(value);
    this.transaction(() => {
      if (this.db.prepare('SELECT id FROM messages WHERE id=?').get(id)) throw new HttpError(409, 'duplicate', 'ID already admitted');
      const count = this.db.prepare('SELECT count(*) AS n FROM messages').get();
      if (Number(count?.n) >= this.capacity) throw new HttpError(429, 'capacity', 'Retained queue capacity reached');
      this.db.prepare("INSERT INTO messages(id,payload,state) VALUES(?,?,'queued')").run(id, data);
    });
  }
  get(id: string): Message {
    const row = this.db.prepare('SELECT * FROM messages WHERE id=?').get(id);
    if (!row) throw new HttpError(404, 'missing', 'Unknown message');
    return decode(row);
  }
  list(): Message[] { return this.db.prepare("SELECT * FROM messages WHERE state='dead' ORDER BY rowid LIMIT 100").all().map(decode); }
  claim(): Message | undefined {
    return this.transaction(() => {
      const now = this.now();
      this.db.prepare(`UPDATE messages SET state=CASE WHEN cycleAttempts>=2 THEN 'dead' ELSE 'queued' END,
        reason=CASE WHEN cycleAttempts>=2 THEN 'attempts_exhausted' ELSE 'lease_expired' END, token=NULL
        WHERE state='running' AND until<=?`).run(now);
      const row = this.db.prepare("SELECT * FROM messages WHERE state='queued' ORDER BY rowid LIMIT 1").get();
      if (!row) return undefined;
      const m = decode(row);
      this.db.prepare("UPDATE messages SET state='running',attempts=attempts+1,cycleAttempts=cycleAttempts+1,token=?,until=?,reason=NULL WHERE id=?").run(randomUUID(), now + this.lease, m.id);
      return this.get(m.id);
    });
  }
  finish(id: string, token: string, outcome: string): boolean {
    if (!['ok', 'poison', 'transient'].includes(outcome)) return false;
    return this.transaction(() => {
      const m = this.get(id);
      if (m.state !== 'running' || m.token !== token || m.until <= this.now()) return false;
      const state = outcome === 'ok' ? 'done' : outcome === 'poison' || m.cycleAttempts >= 2 ? 'dead' : 'queued';
      const reason = outcome === 'ok' ? null : outcome === 'poison' ? 'unsupported_format' : m.cycleAttempts >= 2 ? 'attempts_exhausted' : 'transient_failure';
      this.db.prepare('UPDATE messages SET state=?,reason=?,token=NULL WHERE id=?').run(state, reason, id);
      return true;
    });
  }
  redrive(id: string, expected: number): boolean {
    return this.db.prepare("UPDATE messages SET state='queued',cycleAttempts=0,redrives=redrives+1,token=NULL,until=0 WHERE id=? AND state='dead' AND redrives=? AND redrives<2").run(id, expected).changes === 1;
  }
  close() { this.db.close(); }
}
export class Sink {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS effects(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,amount INTEGER NOT NULL)');
  }
  apply(id: string, value: unknown): boolean {
    identity(id); const data = payload(value); const p = object(JSON.parse(data) as unknown);
    const fingerprint = createHash('sha256').update(data).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT fingerprint FROM effects WHERE id=?').get(id);
      if (row && row.fingerprint !== fingerprint) throw new HttpError(409, 'conflict', 'Operation payload conflict');
      if (!row) this.db.prepare('INSERT INTO effects VALUES(?,?,?)').run(id, fingerprint, Number(p.amount));
      this.db.exec('COMMIT'); return !row;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  total(): number { return Number(this.db.prepare('SELECT coalesce(sum(amount),0) AS total FROM effects').get()?.total); }
  close() { this.db.close(); }
}
