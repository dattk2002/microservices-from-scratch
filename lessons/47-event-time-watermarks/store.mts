import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from '../../lib/http.mts';
export type Partition = 'a' | 'b';
export type Event = {id:string; partition:Partition; time:number; value:number};
export type Window = {start:number; end:number; count:number; sum:number; finalized:boolean};
export type Snapshot = {partitions:{a:number;b:number};global:number;receipts:number;windows:Window[]};
export function object(value:unknown): Record<string,unknown> {
  if(typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400,'invalid_body','Expected object');
  return Object.fromEntries(Object.entries(value));
}
export function integer(value:unknown,min:number,max:number): number {
  if(typeof value !== 'number' || !Number.isInteger(value) || value<min || value>max) throw new HttpError(400,'invalid_number','Integer outside bounds');
  return value;
}
function partition(value:unknown): Partition {
  if(typeof value !== 'string' || (value!=='a' && value!=='b')) throw new HttpError(400,'invalid_partition','Use a or b');
  return value;
}
export function parseEvent(value:unknown): Event {
  const v=object(value);
  if(typeof v.id!=='string' || !/^[A-Za-z0-9_-]{1,32}$/.test(v.id)) throw new HttpError(400,'invalid_id','URL-safe id required');
  return {id:v.id,partition:partition(v.partition),time:integer(v.time,0,99),value:integer(v.value,1,100)};
}
export function windowStart(time:number):number {return Math.floor(time/10)*10;}
function conflict(code:string): never {throw new HttpError(409,code,'State transition rejected');}
export function parseSnapshot(value:unknown): Snapshot {
  const v=object(value), p=object(v.partitions);
  const a=integer(p.a,0,100), b=integer(p.b,0,100), global=integer(v.global,0,100), receipts=integer(v.receipts,0,16);
  if(global!==Math.min(a,b) || !Array.isArray(v.windows) || v.windows.length>10) throw new Error('Invalid snapshot');
  let previous=-10, total=0;
  const windows=v.windows.map((item:unknown):Window => {
    const w=object(item), start=integer(w.start,0,90), end=integer(w.end,10,100), count=integer(w.count,1,16), sum=integer(w.sum,1,1600);
    if(start%10!==0 || start<=previous || end!==start+10 || sum<count || sum>count*100 || typeof w.finalized!=='boolean' || w.finalized!==(end<=global)) throw new Error('Invalid window');
    previous=start; total+=count;
    return {start,end,count,sum,finalized:w.finalized};
  });
  if(total!==receipts) throw new Error('Receipt count mismatch');
  return {partitions:{a,b},global,receipts,windows};
}
export class Store {
  readonly db:DatabaseSync;
  constructor(db:DatabaseSync) {
    this.db=db;
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS progress (partition TEXT PRIMARY KEY, time INTEGER NOT NULL);
      INSERT OR IGNORE INTO progress VALUES ('a',0),('b',0);
      CREATE TABLE IF NOT EXISTS windows (start INTEGER PRIMARY KEY,end INTEGER NOT NULL,count INTEGER NOT NULL,sum INTEGER NOT NULL,finalized INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY,partition TEXT NOT NULL,time INTEGER NOT NULL,value INTEGER NOT NULL,start INTEGER NOT NULL,end INTEGER NOT NULL);`);
  }
  transaction<T>(action:()=>T):T {
    this.db.exec('BEGIN IMMEDIATE');
    try {const result=action();this.db.exec('COMMIT');return result;}
    catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  state():Snapshot {
    const progress=this.db.prepare('SELECT partition,time FROM progress').all();
    const a=progress.find(row=>row.partition==='a')?.time, b=progress.find(row=>row.partition==='b')?.time;
    const count=this.db.prepare('SELECT COUNT(*) AS n FROM receipts').get()?.n;
    const windows=this.db.prepare('SELECT * FROM windows ORDER BY start').all().map(row=>({...row,finalized:row.finalized===1}));
    return parseSnapshot({partitions:{a,b},global:Math.min(integer(a,0,100),integer(b,0,100)),receipts:count,windows});
  }
  event(input:unknown) {
    const e=parseEvent(input);
    return this.transaction(()=> {
      const old=this.db.prepare('SELECT * FROM receipts WHERE id=?').get(e.id);
      if(old) {
        if(old.partition!==e.partition || old.time!==e.time || old.value!==e.value) conflict('id_conflict');
        return {id:e.id,partition:e.partition,time:e.time,value:e.value,start:integer(old.start,0,90),end:integer(old.end,10,100)};
      }
      const state=this.state(), start=windowStart(e.time), end=start+10;
      if(end<=state.global) conflict('window_closed');
      if(state.receipts>=16) conflict('capacity');
      this.db.prepare(`INSERT INTO windows VALUES (?,?,1,?,0) ON CONFLICT(start) DO UPDATE SET count=count+1,sum=sum+excluded.sum`).run(start,end,e.value);
      this.db.prepare('INSERT INTO receipts VALUES (?,?,?,?,?,?)').run(e.id,e.partition,e.time,e.value,start,end);
      return {...e,start,end};
    });
  }
  watermark(input:unknown):Snapshot {
    const v=object(input), p=partition(v.partition), time=integer(v.time,0,100);
    return this.transaction(()=> {
      const state=this.state();
      if(time<state.partitions[p]) conflict('watermark_decreased');
      this.db.prepare('UPDATE progress SET time=? WHERE partition=?').run(time,p);
      const global=Math.min(time,state.partitions[p==='a'?'b':'a']);
      this.db.prepare('UPDATE windows SET finalized=1 WHERE end<=?').run(global);
      return this.state();
    });
  }
}
