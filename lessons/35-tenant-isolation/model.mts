import { sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from '../../lib/http.mts';
export type Claims = {iss:string; aud:string; tenant:string; sub:string; exp:number};
export function object(value: unknown): value is Record<string,unknown> {
 return typeof value==='object' && value!==null && !Array.isArray(value);
}
export function identifier(value: unknown): value is string {
 return typeof value==='string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
}
export function validateClaims(value: unknown, now: number): value is Claims {
 return object(value) && value.iss==='demo-gateway' && value.aud==='documents'
  && identifier(value.tenant) && identifier(value.sub) && typeof value.exp==='number'
  && Number.isSafeInteger(value.exp) && value.exp>now && value.exp<=now+60;
}
export function signContext(claims: Claims, key: KeyObject): string {
 const payload=Buffer.from(JSON.stringify(claims)).toString('base64url');
 return `${payload}.${sign(null,Buffer.from(payload),key).toString('base64url')}`;
}
export function verifyContext(token: unknown,key: KeyObject,now=Math.floor(Date.now()/1000)): Claims {
 try {
  if(typeof token!=='string'||token.length>2048||! /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw Error();
  const [payload,signature]=token.split('.');
  if(!payload||!signature || Buffer.from(signature,'base64url').toString('base64url')!==signature
   || !verify(null,Buffer.from(payload),key,Buffer.from(signature,'base64url'))) throw Error();
  const claims: unknown=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));
  if(!validateClaims(claims,now)) throw Error();
  return claims;
 } catch {throw new HttpError(401,'invalid_context','Invalid tenant context');}
}
export type Document = {id:string;text:string};
export function document(value: unknown): value is Document {
 return object(value)&&identifier(value.id)&&typeof value.text==='string'&&value.text.length<=1024;
}
export function parseWrite(value: unknown): {op:string;text:string} {
 if(!object(value)||Object.keys(value).sort().join(',')!=='op,text'||!identifier(value.op)
  ||typeof value.text!=='string'||value.text.length>1024) throw new HttpError(400,'invalid_write','Expected op and text only');
 return {op:value.op,text:value.text};
}
export class Store {
 readonly db: DatabaseSync;
 constructor(db: DatabaseSync) {
  this.db=db;
  db.exec(`CREATE TABLE IF NOT EXISTS documents(tenant TEXT NOT NULL,id TEXT NOT NULL,text TEXT NOT NULL,PRIMARY KEY(tenant,id));
  CREATE TABLE IF NOT EXISTS receipts(tenant TEXT NOT NULL,op TEXT NOT NULL,id TEXT NOT NULL,text TEXT NOT NULL,PRIMARY KEY(tenant,op));`);
 }
 get(tenant:string,id:string): Document|null {
  const row=this.db.prepare('SELECT id,text FROM documents WHERE tenant=? AND id=?').get(tenant,id);
  if(!row) return null;
  if(!document(row)) throw Error('Corrupt document');
  return {id:row.id,text:row.text};
 }
 list(tenant:string): Document[] {
  return this.db.prepare('SELECT id,text FROM documents WHERE tenant=? ORDER BY id').all(tenant).map(row=>{
   if(!document(row)) throw Error('Corrupt document'); return {id:row.id,text:row.text};
  });
 }
 put(tenant:string,id:string,op:string,text:string): {document:Document;replay:boolean} {
  if(!identifier(tenant)||!identifier(id)) throw Error('Invalid storage key');
  parseWrite({op,text});
  this.db.exec('BEGIN IMMEDIATE');
  try {
   const receipt=this.db.prepare('SELECT id,text FROM receipts WHERE tenant=? AND op=?').get(tenant,op);
   if(receipt) {
    if(receipt.id!==id||receipt.text!==text) throw new HttpError(409,'conflict','Operation conflict');
    this.db.exec('COMMIT'); return {document:{id,text},replay:true};
   }
   const count=this.db.prepare('SELECT count(*) AS n FROM receipts WHERE tenant=?').get(tenant);
   if(count?.n===40 || (!this.get(tenant,id)&&this.list(tenant).length>=20)) throw new HttpError(409,'capacity','Tenant capacity full');
   this.db.prepare('INSERT INTO documents VALUES(?,?,?) ON CONFLICT(tenant,id) DO UPDATE SET text=excluded.text').run(tenant,id,text);
   this.db.prepare('INSERT INTO receipts VALUES(?,?,?,?)').run(tenant,op,id,text);
   this.db.exec('COMMIT'); return {document:{id,text},replay:false};
  } catch(error) {this.db.exec('ROLLBACK');throw error;}
 }
}
