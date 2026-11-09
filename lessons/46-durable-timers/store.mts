import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from '../../lib/http.mts';
export type Timer = {id:string;dueAt:number;value:number;state:'pending'|'uncertain'|'delivered'|'cancelled'|'exhausted';attempts:number};
export type Input = {id:string;dueAt:number;value:number};
export function conflict(): never { throw new HttpError(409,'conflict','Identity, capacity or state conflict'); }
export function record(value:unknown): Record<string,unknown> {
  if (typeof value!=='object'||value===null||Array.isArray(value)) throw new HttpError(400,'invalid_body','Expected object');
  return Object.fromEntries(Object.entries(value));
}
export function integer(value:unknown,min:number,max:number): number {
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max) throw new HttpError(400,'invalid_number','Expected bounded integer');
  return value;
}
export function identity(value:unknown): string {
  if(typeof value!=='string'||! /^[A-Za-z0-9_-]{1,32}$/.test(value)) throw new HttpError(400,'invalid_id','Invalid id');
  return value;
}
export function timerInput(value:unknown): Input {
  const v=record(value); return {id:identity(v.id),dueAt:integer(v.dueAt,0,2147483647),value:integer(v.value,1,100)};
}
function timer(value:unknown): Timer {
  const r=record(value); const state=r.state;
  if(state!=='pending'&&state!=='uncertain'&&state!=='delivered'&&state!=='cancelled'&&state!=='exhausted') throw new Error('Corrupt state');
  return {...timerInput(r),state,attempts:integer(r.attempts,0,4)};
}
function transaction<T>(db:DatabaseSync,fn:()=>T): T {
  db.exec('BEGIN IMMEDIATE');
  try {const result=fn(); db.exec('COMMIT'); return result;} catch(error){db.exec('ROLLBACK'); throw error;}
}
export class Timers {
  private db:DatabaseSync;
  private clock:()=>number;
  constructor(db:DatabaseSync,clock:()=>number) {
    this.db=db; this.clock=clock;
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS timers(id TEXT PRIMARY KEY,dueAt INTEGER NOT NULL,value INTEGER NOT NULL,
      state TEXT NOT NULL,attempts INTEGER NOT NULL);`);
  }
  get(id:string): Timer|undefined {const r=this.db.prepare('SELECT * FROM timers WHERE id=?').get(id);return r?timer(r):undefined;}
  list(): Timer[] {return this.db.prepare('SELECT * FROM timers ORDER BY dueAt,id').all().map(timer);}
  create(input:Input): Timer {
    const t=timerInput(input);
    return transaction(this.db,()=>{
      const previous=this.get(t.id);
      if(previous){if(previous.dueAt!==t.dueAt||previous.value!==t.value) conflict();return previous;}
      if(this.list().length>=16) conflict();
      this.db.prepare("INSERT INTO timers VALUES(?,?,?,'pending',0)").run(t.id,t.dueAt,t.value);
      return this.get(t.id)!;
    });
  }
  cancel(id:string): Timer {
    return transaction(this.db,()=>{
      const t=this.get(id);if(!t) throw new HttpError(404,'not_found','Unknown timer');
      if(t.state!=='cancelled'&&(t.state!=='pending'||t.attempts!==0)) conflict();
      this.db.prepare("UPDATE timers SET state='cancelled' WHERE id=?").run(id);return this.get(id)!;
    });
  }
  select(): Timer|undefined {
    return transaction(this.db,()=>{
      // A crash after the fourth send cannot justify a fifth send.
      this.db.exec("UPDATE timers SET state='exhausted' WHERE state='uncertain' AND attempts=4");
      const row=this.db.prepare("SELECT * FROM timers WHERE state IN ('pending','uncertain') AND dueAt<=? ORDER BY dueAt,id LIMIT 1").get(this.clock());
      if(!row)return undefined;
      const t=timer(row);
      this.db.prepare("UPDATE timers SET state='uncertain',attempts=attempts+1 WHERE id=?").run(t.id);
      return this.get(t.id);
    });
  }
  failed(id:string): void {this.db.prepare("UPDATE timers SET state='exhausted' WHERE id=? AND state='uncertain' AND attempts=4").run(id);}
  delivered(id:string): void {this.db.prepare("UPDATE timers SET state='delivered' WHERE id=? AND state='uncertain'").run(id);}
}
export type Receipt={id:string;value:number};
export class Receipts {
  private db:DatabaseSync;
  constructor(db:DatabaseSync){ this.db=db; db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,value INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS receiver_total(singleton INTEGER PRIMARY KEY CHECK(singleton=1),total INTEGER NOT NULL);
    INSERT OR IGNORE INTO receiver_total VALUES(1,0);`); }
  list(): Receipt[] {return this.db.prepare('SELECT * FROM receipts ORDER BY id').all().map(r=>({id:identity(r.id),value:integer(r.value,1,100)}));}
  total():number {
    const row=this.db.prepare('SELECT total FROM receiver_total WHERE singleton=1').get();
    if(!row)throw new Error('Missing receiver total');
    return integer(row.total,0,1600);
  }
  accept(input:unknown): {id:string;duplicate:boolean;total:number} {
    const r=record(input),id=identity(r.id),value=integer(r.value,1,100);
    return transaction(this.db,()=>{
      const rows=this.list(),previous=rows.find(r=>r.id===id);
      if(previous&&previous.value!==value)conflict();
      if(!previous){
        if(rows.length>=16)conflict();
        this.db.prepare('INSERT INTO receipts VALUES(?,?)').run(id,value);
        this.db.prepare('UPDATE receiver_total SET total=total+? WHERE singleton=1').run(value);
      }
      return {id,duplicate:previous!==undefined,total:this.total()};
    });
  }
}
