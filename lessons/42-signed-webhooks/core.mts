import { createHmac, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage } from 'node:http';
import { HttpError } from '../../lib/http.mts';
export function fail(status: number, code: string): never { throw new HttpError(status,code,code); }
export function object(v: unknown): Record<string,unknown> {
 if(typeof v !== 'object' || v === null || Array.isArray(v)) fail(400,'object_required');
 return Object.fromEntries(Object.entries(v));
}
export type Event = {id:string;delta:number};
export function event(v:unknown):Event {
 const o=object(v);
 if(typeof o.id!=='string'|| !/^[\x00-\x7f]{1,64}$/.test(o.id) || typeof o.delta!=='number'||!Number.isInteger(o.delta)||o.delta===0||Math.abs(o.delta)>100) fail(400,'invalid_event');
 return {id:o.id,delta:o.delta};
}
export function sign(secret:string,timestamp:string,raw:Uint8Array):string {
 return createHmac('sha256',secret).update(timestamp+'.','ascii').update(raw).digest('hex');
}
export function verify(secret:string,t:unknown,s:unknown,raw:Uint8Array,now:number):boolean {
 if(typeof t!=='string'|| !/^(0|[1-9][0-9]{0,10})$/.test(t)|| typeof s!=='string'|| !/^[0-9a-f]{64}$/.test(s)) return false;
 const seconds=Number(t);
 return Number.isSafeInteger(seconds)&&Math.abs(now-seconds)<=60&&timingSafeEqual(Buffer.from(s,'hex'),Buffer.from(sign(secret,t,raw),'hex'));
}
export function secretSetting():string {
 const s=process.env.WEBHOOK_SECRET;
 if(typeof s!=='string'|| !/^[\x20-\x7e]{32,128}$/.test(s)) throw new Error('WEBHOOK_SECRET must be explicit public demo ASCII (32..128)');
 return s;
}
// 64 ASCII characters can each use six JSON bytes (\uXXXX), plus keys/numeric delta.
export const BODY_LIMIT=512;
export function rawBody(req:IncomingMessage):Promise<Buffer> {
 return new Promise((resolve,reject)=>{
  const chunks:Buffer[]=[];let size=0;let failed=false;
  req.on('data',(b:Buffer)=>{
   if(failed) return;
   size+=b.length;
   if(size>BODY_LIMIT) {failed=true;reject(new HttpError(413,'body_too_large','body_too_large'));}
   else chunks.push(b);
  });
  req.once('end',()=>{if(!failed) resolve(Buffer.concat(chunks));});
  req.once('error',reject);
  req.once('aborted',()=>reject(new HttpError(400,'aborted','aborted')));
 });
}
export function parse(raw:Uint8Array):unknown {
 try {return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)) as unknown;} catch {return fail(400,'invalid_json');}
}
export function acknowledgment(v:unknown,id:string):{id:string;duplicate:boolean;total:number} {
 const o=object(v);
 if(o.id!==id||typeof o.duplicate!=='boolean'||typeof o.total!=='number'||!Number.isSafeInteger(o.total)||Math.abs(o.total)>1600) fail(502,'invalid_ack');
 return {id,duplicate:o.duplicate,total:o.total};
}
export class ReceiptStore {
 readonly db:DatabaseSync;
 constructor(path:string) {
  this.db=new DatabaseSync(path);
  this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY, delta INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS counter(singleton INTEGER PRIMARY KEY CHECK(singleton=1),total INTEGER NOT NULL CHECK(total BETWEEN -1600 AND 1600)); INSERT OR IGNORE INTO counter VALUES(1,0)');
 }
 state():{total:number;receipts:number} {
  const row=this.db.prepare('SELECT total,(SELECT count(*) FROM receipts) AS receipts FROM counter').get();
  if(!row||typeof row.total!=='number'||typeof row.receipts!=='number') throw new Error('Invalid state');
  return {total:row.total,receipts:row.receipts};
 }
 apply(e:Event):{id:string;duplicate:boolean;total:number} {
  this.db.exec('BEGIN IMMEDIATE');
  try {
   const old=this.db.prepare('SELECT delta FROM receipts WHERE id=?').get(e.id);
   if(old&&old.delta!==e.delta) fail(409,'payload_conflict');
   if(!old) {
    if(this.state().receipts>=16) fail(409,'receipt_capacity');
    this.db.prepare('INSERT INTO receipts VALUES(?,?)').run(e.id,e.delta);
    this.db.prepare('UPDATE counter SET total=total+? WHERE singleton=1').run(e.delta);
   }
   const result={id:e.id,duplicate:old!==undefined,total:this.state().total};
   this.db.exec('COMMIT'); return result;
  } catch(error) {this.db.exec('ROLLBACK');throw error;}
 }
}
