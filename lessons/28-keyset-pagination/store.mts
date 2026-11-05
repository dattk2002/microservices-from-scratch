import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { HttpError } from '../../lib/http.mts';
export type Row = {id:number; kind:string; value:string};
export type Page = {rows:Row[]; next:string|null};
function fail(status:number, code:string):never {throw new HttpError(status,code,code);}
export function binding(kind:unknown,size:unknown): asserts kind is string {
  if(typeof kind !== 'string' || !['a','b'].includes(kind) || !Number.isInteger(size) || typeof size !== 'number' || size<1 || size>10) fail(400,'invalid_binding');
}
export class Owner {
  db:DatabaseSync;
  readonly now:()=>number; readonly ttl:number;
  constructor(path:string, now:()=>number=Date.now, ttl=60000) {
    this.now=now;this.ttl=ttl;
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS live(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,kind TEXT NOT NULL,size INTEGER NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS frozen(session TEXT REFERENCES sessions(id) ON DELETE CASCADE,id INTEGER,kind TEXT,value TEXT,PRIMARY KEY(session,id));
    CREATE TABLE IF NOT EXISTS tokens(token TEXT PRIMARY KEY,session TEXT REFERENCES sessions(id) ON DELETE CASCADE,pos INTEGER NOT NULL,UNIQUE(session,pos));`);
  }
  put(id:unknown,kind:unknown,value:unknown) {
    if(typeof id!=='number'||!Number.isSafeInteger(id)||id<1||typeof kind!=='string'||!['a','b'].includes(kind)||typeof value!=='string'||Buffer.byteLength(value)>128) fail(400,'invalid_resource');
    const exists=this.db.prepare('SELECT id FROM live WHERE id=?').get(id);
    if(!exists && Number(this.db.prepare('SELECT count(*) n FROM live').get()!.n)>=100) fail(409,'live_capacity');
    this.db.prepare('INSERT INTO live VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,value=excluded.value').run(id,kind,value);
  }
  create(kind:unknown,size:unknown):string {
    binding(kind,size);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM sessions WHERE expires<=?').run(this.now());
      if(Number(this.db.prepare('SELECT count(*) n FROM sessions').get()!.n)>=8) fail(409,'snapshot_capacity');
      const id=randomBytes(24).toString('hex');
      this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(id,kind,size as number,this.now()+this.ttl);
      this.db.prepare('INSERT INTO frozen SELECT ?,id,kind,value FROM live WHERE kind=? ORDER BY id').run(id,kind);
      const token=this.token(id,0); this.db.exec('COMMIT'); return token;
    } catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  token(session:string,pos:number):string {
    const old=this.db.prepare('SELECT token FROM tokens WHERE session=? AND pos=?').get(session,pos);
    if(old) return String(old.token);
    const token=randomBytes(24).toString('hex'); this.db.prepare('INSERT INTO tokens VALUES(?,?,?)').run(token,session,pos);return token;
  }
  page(token:unknown,kind:unknown,size:unknown):Page {
    binding(kind,size);
    if(typeof token!=='string'||! /^[a-f0-9]{48}$/.test(token)) fail(400,'malformed_token');
    const s=this.db.prepare('SELECT t.session,t.pos,s.kind,s.size,s.expires FROM tokens t JOIN sessions s ON s.id=t.session WHERE token=?').get(token);
    if(!s) fail(410,'cursor_unavailable');
    if(Number(s.expires)<=this.now()) fail(410,'cursor_unavailable');
    if(s.kind!==kind||s.size!==size) fail(409,'binding_mismatch');
    const rows=this.db.prepare('SELECT id,kind,value FROM frozen WHERE session=? AND id>? ORDER BY id LIMIT ?').all(s.session!,s.pos!,size as number) as Row[];
    const last=rows.at(-1);
    const more=last && this.db.prepare('SELECT id FROM frozen WHERE session=? AND id>? LIMIT 1').get(s.session!,last.id);
    return {rows,next:more?this.token(String(s.session),last!.id):null};
  }
  close(){this.db.close();}
}
export class ScannerStore {
  db:DatabaseSync;
  constructor(path:string){this.db=new DatabaseSync(path);this.db.exec(`CREATE TABLE IF NOT EXISTS scan(id INTEGER PRIMARY KEY CHECK(id=1),token TEXT,kind TEXT,size INTEGER,deadline INTEGER,done INTEGER); CREATE TABLE IF NOT EXISTS results(id INTEGER PRIMARY KEY,kind TEXT,value TEXT);`);}
  begin(token:string,kind:string,size:number,deadline:number){this.db.exec('BEGIN IMMEDIATE');try{this.db.exec('DELETE FROM results; DELETE FROM scan');this.db.prepare('INSERT INTO scan VALUES(1,?,?,?,?,0)').run(token,kind,size,deadline);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}}
  state(){return this.db.prepare('SELECT * FROM scan').get();}
  apply(expected:string,page:Page,interrupt=false){this.db.exec('BEGIN IMMEDIATE');try{
    const s=this.state(); if(!s||s.token!==expected||s.done) fail(409,'checkpoint_changed');
    for(const r of page.rows)this.db.prepare('INSERT INTO results VALUES(?,?,?)').run(r.id,r.kind,r.value);
    this.db.prepare('UPDATE scan SET token=?,done=? WHERE id=1').run(page.next,page.next===null?1:0);
    if(interrupt) throw new Error('before_commit'); this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e;}}
  rows(){return this.db.prepare('SELECT * FROM results ORDER BY id').all();}
  close(){this.db.close();}
}
