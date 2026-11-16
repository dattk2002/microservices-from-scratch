import { createHash } from 'node:crypto';
import { HttpError } from '../../lib/http.mts';

export function exact(body:unknown,fields:readonly string[]):body is Record<string,unknown> {
  return typeof body==='object'&&body!==null&&!Array.isArray(body)&&Object.keys(body).length===fields.length&&fields.every(f=>Object.hasOwn(body,f));
}
export function revision(v:unknown):v is number {return typeof v==='number'&&Number.isInteger(v)&&v>=0&&v<=16;}
export function key(v:unknown):v is string {return typeof v==='string'&&/^k(?:[0-9]|[12][0-9]|3[01])$/.test(v);}
export function value(v:unknown):v is string {return typeof v==='string'&&/^[A-Za-z]{1,32}$/.test(v);}
export function invalid():never {throw new HttpError(400,'invalid_request','invalid_request');}
export function semantic(status:number,code:string):never {throw new HttpError(status,code,code);}
export function knownError(body:unknown,code:string):boolean {
  return exact(body,['error'])&&exact(body.error,['code','message'])&&body.error.code===code&&body.error.message===code;
}
export function positions(k:string):[number,number] {
  const digest=createHash('sha256').update(k,'utf8').digest();
  return [digest.readUInt32BE(0)%32,digest.readUInt32BE(4)%32];
}
export function buildBits(keys:readonly string[]):string {
  let bits=0;
  for(const k of keys) for(const p of positions(k)) bits=(bits|(1<<p))>>>0;
  return bits.toString(16).padStart(8,'0');
}
export function mayContain(bits:string,k:string):boolean {
  const n=Number.parseInt(bits,16);
  return positions(k).every(p=>(n&(1<<p))!==0);
}
export type Filter={revision:number,m:32,k:2,bits:string};
export function validFilter(body:unknown,r:number):body is Filter {
  return exact(body,['revision','m','k','bits'])&&body.revision===r&&revision(body.revision)&&body.m===32&&body.k===2&&typeof body.bits==='string'&&/^[0-9a-f]{8}$/.test(body.bits);
}
export function routeRevision(raw:string|undefined):number {
  if(raw===undefined||!/^(?:[0-9]|1[0-6])$/.test(raw)) invalid();
  return Number(raw);
}

export function validateHost(host:unknown):void {
  if(host!==undefined&&host!=='127.0.0.1') throw new Error('HOST must be 127.0.0.1');
}
