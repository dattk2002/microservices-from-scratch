import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { HttpError } from '../../lib/http.mts';
export const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function fail(status: number): never { throw new HttpError(status,'upload_contract',`Upload contract rejected (${status})`); }
export function record(x: unknown): Record<string,unknown> { if(!x || typeof x!=='object'||Array.isArray(x))fail(400);return x as Record<string,unknown>; }
export function id(x: unknown): string {if(typeof x!=='string'|| !/^[A-Za-z0-9_-]{1,32}$/.test(x))fail(400);return x;}
export function sha(x: unknown): string {if(typeof x!=='string'|| !/^[a-f0-9]{64}$/.test(x))fail(400);return x;}
export function integer(x: unknown,min:number,max:number):number {if(typeof x!=='number'||!Number.isInteger(x)||x<min||x>max)fail(400);return x;}
export function decode(x:unknown,max:number):Buffer {if(typeof x!=='string'||x.length>4*Math.ceil(max/3)||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(x))fail(400);const b=Buffer.from(x,'base64');if(!b.length||b.length>max||b.toString('base64')!==x)fail(400);return b;}
type Upload={id:string;parts:number;size:number;sha256:string;status:string};
export class Store {
 readonly db:DatabaseSync;
 constructor(path=':memory:') {this.db=new DatabaseSync(path);this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
 CREATE TABLE IF NOT EXISTS uploads(id TEXT PRIMARY KEY,parts INTEGER,size INTEGER,sha256 TEXT,status TEXT,object BLOB);
 CREATE TABLE IF NOT EXISTS parts(id TEXT,number INTEGER,bytes BLOB,sha256 TEXT,PRIMARY KEY(id,number));`);}
 close(){this.db.close();}
 private transaction<T>(fn:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 private row(key:string):Upload {const r=this.db.prepare('SELECT id,parts,size,sha256,status FROM uploads WHERE id=?').get(id(key));if(!r)fail(404);return {id:String(r.id),parts:Number(r.parts),size:Number(r.size),sha256:String(r.sha256),status:String(r.status)};}
 get(key:string){const r=this.row(key);const received=this.db.prepare('SELECT number,length(bytes) AS size,sha256 FROM parts WHERE id=? ORDER BY number').all(key).map(p=>({number:Number(p.number),size:Number(p.size),sha256:String(p.sha256)}));return {...r,received};}
 create(input:unknown){const v=record(input);const key=id(v.uploadId),parts=integer(v.parts,1,8),size=integer(v.size,1,8192),hash=sha(v.sha256);if(size<parts||size>parts*1024)fail(400);
 return this.transaction(()=>{const old=this.db.prepare('SELECT * FROM uploads WHERE id=?').get(key);if(old){if(old.parts!==parts||old.size!==size||old.sha256!==hash)fail(409);}else{if(Number(this.db.prepare('SELECT count(*) AS n FROM uploads').get()!.n)>=16)fail(409);this.db.prepare("INSERT INTO uploads VALUES(?,?,?,?,'open',NULL)").run(key,parts,size,hash);}return this.get(key);});}
 put(key:string,number:number,input:unknown){id(key);integer(number,1,8);const v=record(input),bytes=decode(v.base64,1024),hash=sha(v.sha256);if(digest(bytes)!==hash)fail(400);
 return this.transaction(()=>{const r=this.row(key);if(number>r.parts)fail(400);if(r.status==='aborted')fail(409);const old=this.db.prepare('SELECT bytes,sha256 FROM parts WHERE id=? AND number=?').get(key,number);if(old){if(!(old.bytes instanceof Uint8Array)||!bytes.equals(old.bytes)||old.sha256!==hash)fail(409);}else{if(r.status!=='open')fail(409);this.db.prepare('INSERT INTO parts VALUES(?,?,?,?)').run(key,number,bytes,hash);}return this.get(key);});}
 complete(key:string){return this.transaction(()=>{const r=this.row(key);if(r.status==='aborted')fail(409);if(r.status==='complete')return this.get(key);const rows=this.db.prepare('SELECT number,bytes FROM parts WHERE id=? ORDER BY number').all(key);if(rows.length!==r.parts)fail(409);const buffers=rows.map((p,i)=>{if(p.number!==i+1||!(p.bytes instanceof Uint8Array))fail(409);return Buffer.from(p.bytes);});const bytes=Buffer.concat(buffers);if(bytes.length!==r.size||digest(bytes)!==r.sha256)fail(409);this.db.prepare("UPDATE uploads SET status='complete',object=? WHERE id=?").run(bytes,key);return this.get(key);});}
 abort(key:string){return this.transaction(()=>{const r=this.row(key);if(r.status==='complete')fail(409);this.db.prepare('DELETE FROM parts WHERE id=?').run(key);this.db.prepare("UPDATE uploads SET status='aborted' WHERE id=?").run(key);return this.get(key);});}
 object(key:string){const r=this.row(key);if(r.status!=='complete')return undefined;const o=this.db.prepare('SELECT object FROM uploads WHERE id=?').get(key);if(!(o?.object instanceof Uint8Array))throw new Error('Corrupt object');return {id:key,base64:Buffer.from(o.object).toString('base64'),size:r.size,sha256:r.sha256};}
}
