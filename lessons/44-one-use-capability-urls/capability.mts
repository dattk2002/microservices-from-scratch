import { createHmac, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { HttpError } from '../../lib/http.mts';
export function fail(status: number): never { throw new HttpError(status,'capability_rejected','Request rejected'); }
export const catalogue: Readonly<Record<string,string>> = Object.freeze({doc:'Ghi chú: mỗi quyền chỉ mở một lần.',photo:'Ảnh mẫu bằng chữ: chiếc thuyền trên hồ.',report:'Báo cáo mẫu: ba chuyến giao hàng hoàn tất.'});
function objectId(v: unknown): v is string { return typeof v==='string' && Object.hasOwn(catalogue,v); }
function requestId(v: unknown): v is string { return typeof v==='string' && /^[\x20-\x7e]{1,32}$/.test(v); }
export function record(v: unknown): v is Record<string,unknown> { return typeof v==='object' && v!==null && !Array.isArray(v); }
export function parseIssue(v: unknown): {requestId:string;objectId:string;ttlSeconds:number} {
  if (!record(v) || !requestId(v.requestId) || !objectId(v.objectId) || typeof v.ttlSeconds!=='number' || !Number.isInteger(v.ttlSeconds) || v.ttlSeconds<1 || v.ttlSeconds>60) fail(400);
  return {requestId:v.requestId,objectId:v.objectId,ttlSeconds:v.ttlSeconds};
}
function mac(payload:string,secret:string): string { return createHmac('sha256',secret).update(payload).digest('hex'); }
export function sign([id,expiry,rid]: readonly [string,number,string],secret:string):string {
  const payload=Buffer.from(JSON.stringify([1,'objects-demo','GET',id,expiry,rid])).toString('base64url');
  return payload+'.'+mac(payload,secret);
}
export function verify(ticket:string,id:string,now:number,secret:string):string {
  if(ticket.length>1024 || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(ticket)) fail(403);
  const [payload,signature]=ticket.split('.');
  if(!payload || !signature || !timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(mac(payload,secret),'hex'))) fail(403);
  let tuple:unknown;
  try { tuple=JSON.parse(Buffer.from(payload,'base64url').toString('utf8')); } catch { fail(403); }
  if(!Array.isArray(tuple) || tuple.length!==6) fail(403);
  const [version,audience,method,obj,expiry,rid]:unknown[]=tuple;
  if(version!==1 || audience!=='objects-demo' || method!=='GET' || !objectId(obj) || obj!==id || typeof expiry!=='number' || !Number.isSafeInteger(expiry) || expiry<0 || !requestId(rid) || now>=expiry) fail(403);
  if(Buffer.from(JSON.stringify(tuple)).toString('base64url')!==payload) fail(403);
  return rid;
}
export class Ledger {
  readonly db:DatabaseSync; readonly secret:string;
  constructor(db:DatabaseSync,secret:string) {
    this.db=db; this.secret=secret;
    db.exec('PRAGMA busy_timeout=2000; CREATE TABLE IF NOT EXISTS issues (id TEXT PRIMARY KEY, object TEXT NOT NULL, ttl INTEGER NOT NULL, expiry INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS spent (id TEXT PRIMARY KEY)');
  }
  transaction<T>(action:()=>T):T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result=action(); this.db.exec('COMMIT'); return result; } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  issue(value:unknown,now:number): {path:string;expiresAt:number;requestId:string} {
    const input=parseIssue(value);
    return this.transaction(()=>{
      const existing=this.db.prepare('SELECT object,ttl,expiry FROM issues WHERE id=?').get(input.requestId);
      let expiry=now+input.ttlSeconds;
      if(existing) {
        if(existing.object!==input.objectId || existing.ttl!==input.ttlSeconds) fail(409);
        if(typeof existing.expiry!=='number') throw new Error('Corrupt expiry');
        expiry=existing.expiry;
      } else {
        if(Number(this.db.prepare('SELECT count(*) AS n FROM issues').get()?.n)>=16) fail(503);
        this.db.prepare('INSERT INTO issues VALUES (?,?,?,?)').run(input.requestId,input.objectId,input.ttlSeconds,expiry);
      }
      return {path:`/objects/${input.objectId}?ticket=${sign([input.objectId,expiry,input.requestId],this.secret)}`,expiresAt:expiry,requestId:input.requestId};
    });
  }
  consume(id:string):void {
    this.transaction(()=>{
      if(this.db.prepare('SELECT id FROM spent WHERE id=?').get(id)) fail(409);
      if(Number(this.db.prepare('SELECT count(*) AS n FROM spent').get()?.n)>=16) fail(503);
      this.db.prepare('INSERT INTO spent VALUES (?)').run(id);
    });
  }
}
export function clock(env:NodeJS.ProcessEnv): {now:()=>number;advance:(value:unknown)=>void} {
  if(env.TEACHING_CONTROLS!==undefined && env.TEACHING_CONTROLS!=='1') throw new Error('Invalid TEACHING_CONTROLS');
  const fixed=env.TEACHING_EPOCH_SECONDS;
  if(fixed!==undefined && (env.TEACHING_CONTROLS!=='1' || !/^\d{1,10}$/.test(fixed))) throw new Error('Invalid teaching epoch');
  let offset=0;
  return {now:()=> (fixed===undefined?Math.floor(Date.now()/1000):Number(fixed))+offset,
    advance:(value:unknown)=>{
      if(!record(value) || typeof value.seconds!=='number' || !Number.isInteger(value.seconds) || value.seconds<1 || value.seconds>60 || offset+value.seconds>3600) fail(400);
      offset+=value.seconds;
    }};
}
