import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {HttpError} from '../../lib/http.mts';
export const ZERO='0'.repeat(64);
export type Payload={id:string;action:'created'|'approved'|'cancelled';subject:string};
export type Entry=Payload & {seq:number;prev:string;hash:string};
export type Head={count:number;hash:string};
export type Export={entries:Entry[];head:Head};
export function fail(status:number,message:string):never{throw new HttpError(status,message,message);}
function isObject(v:unknown):v is Record<string,unknown>{return v!==null&&typeof v==='object'&&!Array.isArray(v);}
export function object(v:unknown):Record<string,unknown>{if(!isObject(v))fail(400,'object_required');return v;}
export function keys(v:Record<string,unknown>,names:string[]){if(Object.keys(v).length!==names.length||names.some(k=>!Object.hasOwn(v,k)))fail(400,'invalid_fields');}
export function input(v:unknown):Payload{
 const o=object(v);keys(o,['id','action','subject']);
 if(typeof o.id!=='string'||! /^[A-Za-z0-9_-]{1,32}$/.test(o.id)||typeof o.subject!=='string'||! /^[A-Za-z0-9_-]{1,32}$/.test(o.subject))fail(400,'invalid_identifier');
 if(typeof o.action!=='string'||(o.action!=='created'&&o.action!=='approved'&&o.action!=='cancelled'))fail(400,'invalid_action');
 return {id:o.id,action:o.action,subject:o.subject};
}
export function digest(seq:number,prev:string,id:string,action:string,subject:string){return createHash('sha256').update(JSON.stringify([1,seq,prev,id,action,subject]),'utf8').digest('hex');}
export function head(entries:Entry[]):Head{return {count:entries.length,hash:entries.at(-1)?.hash??ZERO};}
export function validate(value:unknown):Export{
 try{
 const o=object(value);keys(o,['entries','head']);if(!Array.isArray(o.entries)||o.entries.length>16)fail(502,'invalid_chain');
 const entries:Entry[]=[];const ids=new Set<string>();let prev=ZERO;
 for(const raw of o.entries){const e=object(raw);keys(e,['seq','prev','id','action','subject','hash']);const p=input({id:e.id,action:e.action,subject:e.subject});
 if(e.seq!==entries.length+1||e.prev!==prev||ids.has(p.id)||typeof e.hash!=='string'||! /^[a-f0-9]{64}$/.test(e.hash)||e.hash!==digest(e.seq,prev,p.id,p.action,p.subject))fail(502,'invalid_chain');
 entries.push({...p,seq:e.seq,prev,hash:e.hash});ids.add(p.id);prev=e.hash;
 }
 const h=object(o.head);keys(h,['count','hash']);if(h.count!==entries.length||h.hash!==prev)fail(502,'invalid_head');return {entries,head:head(entries)};
 }catch{fail(502,'invalid_export');}
}
function transaction<T>(db:DatabaseSync,work:()=>T):T{db.exec('BEGIN IMMEDIATE');try{const result=work();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}
export class Log{
 readonly db:DatabaseSync;
 constructor(db:DatabaseSync){this.db=db;db.exec('PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS entries(seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, action TEXT NOT NULL, subject TEXT NOT NULL, prev TEXT NOT NULL, hash TEXT NOT NULL)');}
 export():Export{const rows=this.db.prepare('SELECT seq,prev,id,action,subject,hash FROM entries ORDER BY seq').all();return validate({entries:rows,head:{count:rows.length,hash:rows.at(-1)?.hash??ZERO}});}
 append(value:unknown):Entry{const p=input(value);return transaction(this.db,()=>{
 const all=this.export();const old=all.entries.find(e=>e.id===p.id);if(old){if(old.action!==p.action||old.subject!==p.subject)fail(409,'conflict');return old;}
 if(all.entries.length===16)fail(409,'capacity');const seq=all.head.count+1;const prev=all.head.hash;const e={seq,prev,...p,hash:digest(seq,prev,p.id,p.action,p.subject)};
 // The ordered entry is also the immutable idempotency receipt: one atomic INSERT.
 this.db.prepare('INSERT INTO entries(seq,id,action,subject,prev,hash) VALUES(?,?,?,?,?,?)').run(e.seq,e.id,e.action,e.subject,e.prev,e.hash);return e;
 });}
}
export class Anchor{
 readonly db:DatabaseSync;
 constructor(db:DatabaseSync){this.db=db;db.exec('PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS checkpoint(singleton INTEGER PRIMARY KEY CHECK(singleton=1), count INTEGER NOT NULL, hash TEXT NOT NULL)');db.prepare('INSERT OR IGNORE INTO checkpoint VALUES(1,0,?)').run(ZERO);}
 state():Head{const row=this.db.prepare('SELECT count,hash FROM checkpoint WHERE singleton=1').get();if(!row||typeof row.count!=='number'||!Number.isInteger(row.count)||row.count<0||row.count>16||typeof row.hash!=='string'||! /^[a-f0-9]{64}$/.test(row.hash)||(row.count===0&&row.hash!==ZERO))throw new Error('invalid checkpoint storage');return {count:row.count,hash:row.hash};}
 accept(chain:Export,advance:boolean){return transaction(this.db,()=>{
 const pin=this.state();if(chain.head.count<pin.count||(pin.count>0&&chain.entries[pin.count-1]?.hash!==pin.hash))fail(409,'prefix_conflict');
 if(advance)this.db.prepare('UPDATE checkpoint SET count=?,hash=? WHERE singleton=1').run(chain.head.count,chain.head.hash);
 return {count:chain.head.count,checkpoint:advance?chain.head:pin};
 });}
}
export type Mode='clean'|'edit'|'truncate'|'rewrite';
export function view(source:Export,mode:Mode):Export{
 const entries=source.entries.map(e=>({...e}));if(mode==='clean')return {entries,head:head(entries)};
 if(!entries.length)fail(409,'empty_history');
 if(mode==='truncate')entries.pop();else {entries[0]!.subject=entries[0]!.subject==='changed'?'different':'changed';if(mode==='rewrite'){let prev=ZERO;for(const e of entries){e.prev=prev;e.hash=digest(e.seq,prev,e.id,e.action,e.subject);prev=e.hash;}}}
 return {entries,head:head(entries)};
}
