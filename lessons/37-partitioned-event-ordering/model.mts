import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from '../../lib/http.mts';

export type Input = {id:string;key:string;delta:number};
export type Event = Input & {partition:number;offset:number};
export const MAX_BALANCE = 4_000_000;
export function invalid():never { throw new HttpError(400,'invalid','invalid event or envelope'); }
export function record(value:unknown):Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string,unknown>;
}
export function integer(value:unknown,min:number,max:number):number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value<min || value>max) return invalid();
  return value;
}
function identifier(value:unknown,max:number):string {
  if (typeof value !== 'string' || value.length<1 || value.length>max) return invalid();
  // Bounded ASCII identifiers avoid Unicode normalization and routing ambiguity.
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) return invalid();
  return value;
}
export function input(value:unknown):Input {
  const v=record(value);
  const id=identifier(v.id,64), key=identifier(v.key,32);
  const delta=integer(v.delta,-1_000_000,1_000_000);
  if (delta===0) return invalid();
  return {id,key,delta};
}
export function route(key:string):number {
  let hash=0;
  for (const character of key) hash=(hash*31+character.charCodeAt(0))%3;
  return hash;
}
export function event(value:unknown):Event {
  const v=record(value), data=input(v);
  const partition=integer(v.partition,0,2), offset=integer(v.offset,1,32);
  if (route(data.key)!==partition) return invalid();
  return {...data,partition,offset};
}
// Pure decision: no gap buffering and no moving a checkpoint backwards.
export class Gap extends HttpError {
  readonly expected:number;
  constructor(expected:number) {super(409,'gap',`expected offset ${expected}`);this.expected=expected;}
}
export function decision(checkpoint:number,offset:number):'next'|'old' {
  if (offset>checkpoint+1) throw new Gap(checkpoint+1);
  return offset===checkpoint+1?'next':'old';
}
function conflict():never { throw new HttpError(409,'conflict','event identity or payload conflict'); }
function full(message:string):never { throw new HttpError(409,'capacity',message); }
function transaction<T>(db:DatabaseSync,work:()=>T):T {
  db.exec('BEGIN IMMEDIATE');
  try { const result=work(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
function same(row:Record<string,unknown>,e:Event):boolean {
  return row.id===e.id && row.key===e.key && row.delta===e.delta && row.partition===e.partition && row.offset===e.offset;
}
export class Broker {
  readonly db:DatabaseSync;
  constructor(db:DatabaseSync) {
    this.db=db;
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS keys(key TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,key TEXT NOT NULL,delta INTEGER NOT NULL,partition INTEGER NOT NULL,offset INTEGER NOT NULL,UNIQUE(partition,offset));`);
  }
  append(value:unknown):Event {
    const data=input(value), partition=route(data.key);
    return transaction(this.db,()=>{
      const old=this.db.prepare('SELECT * FROM events WHERE id=?').get(data.id);
      if (old) {
        if (old.key!==data.key || old.delta!==data.delta) return conflict();
        return event(old);
      }
      const count=this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE partition=?').get(partition);
      const offset=Number(count?.n)+1;
      if (offset>32) return full('partition retention full');
      if (!this.db.prepare('SELECT key FROM keys WHERE key=?').get(data.key)) {
        if (Number(this.db.prepare('SELECT COUNT(*) AS n FROM keys').get()?.n)>=16) return full('key retention full');
        this.db.prepare('INSERT INTO keys VALUES (?)').run(data.key);
      }
      this.db.prepare('INSERT INTO events VALUES (?,?,?,?,?)').run(data.id,data.key,data.delta,partition,offset);
      return {...data,partition,offset};
    });
  }
  read(partition:number,after:number,limit:number):Event[] {
    integer(partition,0,2); integer(after,0,32); integer(limit,1,8);
    return this.db.prepare('SELECT * FROM events WHERE partition=? AND offset>? ORDER BY offset LIMIT ?').all(partition,after,limit).map(event);
  }
}
export class Consumer {
  readonly db:DatabaseSync;
  constructor(db:DatabaseSync) {
    this.db=db;
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS checkpoints(partition INTEGER PRIMARY KEY,offset INTEGER NOT NULL);
      INSERT OR IGNORE INTO checkpoints VALUES(0,0),(1,0),(2,0);
      CREATE TABLE IF NOT EXISTS balances(key TEXT PRIMARY KEY,balance INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,key TEXT NOT NULL,delta INTEGER NOT NULL,partition INTEGER NOT NULL,offset INTEGER NOT NULL,UNIQUE(partition,offset));`);
  }
  checkpoint(partition:number):number {
    integer(partition,0,2);
    return Number(this.db.prepare('SELECT offset FROM checkpoints WHERE partition=?').get(partition)?.offset);
  }
  apply(values:unknown[]):void {
    if (values.length>8) return invalid();
    const events=values.map(event);
    transaction(this.db,()=>{
      for (const e of events) {
        const checkpoint=this.checkpoint(e.partition);
        const at=this.db.prepare('SELECT * FROM receipts WHERE partition=? AND offset=?').get(e.partition,e.offset);
        const byId=this.db.prepare('SELECT * FROM receipts WHERE id=?').get(e.id);
        if ((at && !same(at,e)) || (byId && !same(byId,e))) return conflict();
        if (decision(checkpoint,e.offset)==='old') {
          if (!at || !same(at,e)) return conflict();
          continue;
        }
        const current=this.db.prepare('SELECT balance FROM balances WHERE key=?').get(e.key);
        if (!current && Number(this.db.prepare('SELECT COUNT(*) AS n FROM balances').get()?.n)>=16) return full('key retention full');
        if (Number(this.db.prepare('SELECT COUNT(*) AS n FROM receipts').get()?.n)>=96) return full('receipt retention full');
        const balance=Number(current?.balance??0)+e.delta;
        if (Math.abs(balance)>MAX_BALANCE) return full('balance bound exceeded');
        this.db.prepare('INSERT INTO receipts VALUES (?,?,?,?,?)').run(e.id,e.key,e.delta,e.partition,e.offset);
        this.db.prepare('INSERT INTO balances VALUES (?,?) ON CONFLICT(key) DO UPDATE SET balance=excluded.balance').run(e.key,balance);
        this.db.prepare('UPDATE checkpoints SET offset=? WHERE partition=?').run(e.offset,e.partition);
      }
    });
  }
  state():{checkpoints:number[];balances:Record<string,number>} {
    const balances=new Map<string,number>();
    for (const row of this.db.prepare('SELECT key,balance FROM balances ORDER BY key').all()) {
      if (typeof row.key!=='string' || typeof row.balance!=='number') throw new Error('corrupt balance');
      balances.set(row.key,row.balance);
    }
    return {checkpoints:[this.checkpoint(0),this.checkpoint(1),this.checkpoint(2)],balances:Object.fromEntries(balances)};
  }
}
