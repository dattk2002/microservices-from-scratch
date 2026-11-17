import type { DatabaseSync } from 'node:sqlite';
import { eventValid, integer, reject } from './contracts.mts';
import type { Event, Pair, Side, State, Watermarks } from './contracts.mts';

// A caller owns the connection; this also permits trigger-based fault injection in units.
export class JoinStore {
  readonly db: DatabaseSync;
  constructor(db: DatabaseSync, identity = 'lesson70') {
    this.db=db;
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(identity)) throw new Error('Invalid STORE_ID');
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), name TEXT NOT NULL, contract TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS marks (side TEXT PRIMARY KEY CHECK(side IN ('left','right')), time INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, side TEXT NOT NULL, key TEXT NOT NULL, time INTEGER NOT NULL, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pairs (leftId TEXT NOT NULL, rightId TEXT NOT NULL, key TEXT NOT NULL, leftTime INTEGER NOT NULL, rightTime INTEGER NOT NULL, final INTEGER NOT NULL, PRIMARY KEY(leftId,rightId));`);
    this.transaction(()=>{
      const contract='interval:0..3;receipts:16/side;pairs:256;v1';
      const existing=db.prepare('SELECT name,contract FROM identity WHERE singleton=1').get();
      if (existing && (existing.name !== identity || existing.contract !== contract)) throw new Error('Persistent configuration mismatch');
      db.prepare('INSERT OR IGNORE INTO identity VALUES (1,?,?)').run(identity,contract);
      db.exec("INSERT OR IGNORE INTO marks VALUES ('left',-1),('right',-1)");
    });
  }
  private transaction<T>(action: ()=>T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result=action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private marks(): Watermarks {
    const left=this.db.prepare("SELECT time FROM marks WHERE side='left'").get()?.time;
    const right=this.db.prepare("SELECT time FROM marks WHERE side='right'").get()?.time;
    if (!integer(left,-1,104) || !integer(right,-1,104)) throw new Error('Corrupt watermarks');
    return {left,right};
  }
  private events(): Event[] {
    return this.db.prepare('SELECT id,side,key,time,value FROM events ORDER BY id COLLATE BINARY').all().map(row=>{
      if (!eventValid(row)) throw new Error('Corrupt receipt');
      return row;
    });
  }
  event(e: Event): {id: string; duplicate: boolean} {
    if (!eventValid(e)) throw new Error('Invalid event');
    return this.transaction(()=>{
      const receipts=this.events();
      const existing=receipts.find(row=>row.id === e.id);
      if (existing) {
        if (existing.side !== e.side || existing.key !== e.key || existing.time !== e.time || existing.value !== e.value) reject('id_conflict');
        return {id:e.id,duplicate:true};
      }
      if (e.time <= this.marks()[e.side]) reject('late_event');
      if (receipts.filter(row=>row.side === e.side).length >= 16) reject('capacity');
      this.db.prepare('INSERT INTO events VALUES (?,?,?,?,?)').run(e.id,e.side,e.key,e.time,e.value);
      for (const other of receipts) {
        if (other.side === e.side || other.key !== e.key) continue;
        const left=e.side === 'left' ? e : other;
        const right=e.side === 'right' ? e : other;
        if (right.time < left.time || right.time > left.time+3) continue;
        this.db.prepare('INSERT INTO pairs VALUES (?,?,?,?,?,0)').run(left.id,right.id,e.key,left.time,right.time);
      }
      return {id:e.id,duplicate:false};
    });
  }
  watermark(side: Side, time: number): {watermarks: Watermarks} {
    if (!integer(time,0,104)) throw new Error('Invalid watermark');
    return this.transaction(()=>{
      if (time < this.marks()[side]) reject('watermark_regression');
      this.db.prepare('UPDATE marks SET time=? WHERE side=?').run(time,side);
      const watermarks=this.marks();
      this.db.prepare('UPDATE pairs SET final=1 WHERE final=0 AND ? >= leftTime+3 AND ? >= rightTime').run(watermarks.right,watermarks.left);
      return {watermarks};
    });
  }
  state(): State {
    // One synchronous snapshot, no async interleaving within this process.
    const pairs: Pair[]=this.db.prepare('SELECT * FROM pairs ORDER BY leftId COLLATE BINARY,rightId COLLATE BINARY').all().map(row=>{
      const {leftId,rightId,key,leftTime,rightTime,final}=row;
      if (typeof leftId !== 'string' || typeof rightId !== 'string' || (key !== 'a' && key !== 'b')
        || !integer(leftTime,0,100) || !integer(rightTime,0,100) || (final !== 0 && final !== 1)) throw new Error('Corrupt pair');
      return {leftId,rightId,key,leftTime,rightTime,final:final === 1};
    });
    return {watermarks:this.marks(),events:this.events(),pairs};
  }
}
