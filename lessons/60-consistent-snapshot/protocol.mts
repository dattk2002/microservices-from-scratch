import { HttpError } from '../../lib/http.mts';
export type Replica = 'a'|'b';
export type Transfer = {from:Replica;seq:number;kind:'transfer';amount:number};
export type Packet = Transfer | {from:Replica;seq:number;kind:'marker';snapshotId:string};
export type Snapshot = {snapshotId:string;localBalance:number;channelOpen:boolean;inFlight:Transfer[]};
export function object(v:unknown): v is Record<string,unknown> { return typeof v==='object' && v!==null && !Array.isArray(v); }
export function exact(v:unknown, keys:string[]): v is Record<string,unknown> { return object(v) && Object.keys(v).length===keys.length && keys.every(k=>Object.hasOwn(v,k)); }
export function replica(v:unknown): v is Replica { return v==='a'||v==='b'; }
export function integer(v:unknown,min:number,max:number): v is number { return typeof v==='number' && Number.isSafeInteger(v) && v>=min && v<=max; }
export function snapshotId(v:unknown): v is string { return typeof v==='string' && /^[A-Za-z0-9_-]{1,16}$/.test(v); }
export function packet(v:unknown): v is Packet {
  if(!object(v)||!replica(v.from)||!integer(v.seq,1,16)) return false;
  return v.kind==='transfer' ? exact(v,['from','seq','kind','amount'])&&integer(v.amount,1,5) : v.kind==='marker'&&exact(v,['from','seq','kind','snapshotId'])&&snapshotId(v.snapshotId);
}
export function snapshot(v:unknown,from:Replica): v is Snapshot {
  if(!exact(v,['snapshotId','localBalance','channelOpen','inFlight'])||!snapshotId(v.snapshotId)||!integer(v.localBalance,0,90)||typeof v.channelOpen!=='boolean'||!Array.isArray(v.inFlight)||v.inFlight.length>16) return false;
  let previous=0;
  for(const p of v.inFlight) { if(!packet(p)||p.kind!=='transfer'||p.from===from||p.seq<=previous) return false; previous=p.seq; }
  return true;
}
export function fail(status:number,code:string):never { throw new HttpError(status,code,code); }
export function requireBody(v:unknown,field:string): Record<string,unknown> { if(!exact(v,[field])) fail(400,'invalid_body'); return v; }
export function same(a:Packet,b:Packet) { return a.from===b.from&&a.seq===b.seq&&a.kind===b.kind&&(a.kind==='transfer'&&b.kind==='transfer'?a.amount===b.amount:a.kind==='marker'&&b.kind==='marker'&&a.snapshotId===b.snapshotId); }
