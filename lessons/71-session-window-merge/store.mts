import type { DatabaseSync } from 'node:sqlite';
import { sessions } from './core.mts';
import type { Event, State } from './core.mts';
import { eventValid, integer, reject } from './contracts.mts';

// Connection lifetime belongs to the service (or the test), never to a store wrapper.
export class SessionStore {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync, identity = 'lesson71') {
    this.db=db;
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(identity)) throw new Error('Invalid SOURCE_ID');
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), source TEXT NOT NULL, contract TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS watermark (singleton INTEGER PRIMARY KEY CHECK(singleton=1), time INTEGER NOT NULL CHECK(time BETWEEN -1 AND 103));
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, key TEXT NOT NULL CHECK(key IN ('a','b')), time INTEGER NOT NULL CHECK(time BETWEEN 0 AND 100), value INTEGER NOT NULL CHECK(value BETWEEN 0 AND 9));`);
    this.transaction(()=>{
      const contract='session-gap:3-inclusive;receipts:32;v1';
      const saved=db.prepare('SELECT source,contract FROM identity WHERE singleton=1').get();
      if (saved && (saved.source !== identity || saved.contract !== contract)) throw new Error('Persistent configuration mismatch');
      db.prepare('INSERT OR IGNORE INTO identity VALUES (1,?,?)').run(identity,contract);
      db.exec('INSERT OR IGNORE INTO watermark VALUES (1,-1)');
    });
  }
  private transaction<T>(action: ()=>T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result=action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private mark(): number {
    const value=this.db.prepare('SELECT time FROM watermark WHERE singleton=1').get()?.time;
    if (!integer(value,-1,103)) throw new Error('Corrupt watermark');
    return value;
  }
  private receipts(): Event[] {
    return this.db.prepare('SELECT id,key,time,value FROM receipts ORDER BY time,id COLLATE BINARY').all().map(row=>{
      if (!eventValid(row)) throw new Error('Corrupt receipt');
      return row;
    });
  }
  event(e: Event): {id: string; duplicate: boolean} {
    if (!eventValid(e)) throw new Error('Invalid event');
    return this.transaction(()=>{
      const receipts=this.receipts();
      const existing=receipts.find(receipt=>receipt.id === e.id);
      if (existing) {
        if (existing.key !== e.key || existing.time !== e.time || existing.value !== e.value) reject('id_conflict');
        return {id:e.id,duplicate:true};
      }
      if (e.time <= this.mark()) reject('late_event');
      if (receipts.length >= 32) reject('capacity');
      this.db.prepare('INSERT INTO receipts VALUES (?,?,?,?)').run(e.id,e.key,e.time,e.value);
      return {id:e.id,duplicate:false};
    });
  }
  watermark(time: number): {watermark: number} {
    if (!integer(time,0,103)) throw new Error('Invalid watermark');
    return this.transaction(()=>{
      if (time < this.mark()) reject('watermark_regression');
      this.db.prepare('UPDATE watermark SET time=? WHERE singleton=1').run(time);
      return {watermark:time};
    });
  }
  state(): State {
    return this.transaction(()=>{
      const watermark=this.mark();
      return {watermark,sessions:sessions(this.receipts(),watermark)};
    });
  }
}
