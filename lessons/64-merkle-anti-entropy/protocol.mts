import { createHash } from 'node:crypto';
import { HttpError,readJson } from '../../lib/http.mts';
import type { IncomingMessage } from 'node:http';

export const KEYS=['k0','k1','k2','k3','k4','k5','k6','k7'] as const;
export type Key=typeof KEYS[number];
export type Value=null|string;
export type PatchRecord={key:Key,value:Value};
export type Root={revision:number,hash:string};
export type TreeNode=Root & {path:string,children:null|{left:string,right:string}};
export const BODY_LIMIT=4096;
export function exact(v:unknown,fields:readonly string[]):v is Record<string,unknown> {
  return typeof v==='object'&&v!==null&&!Array.isArray(v)&&Object.keys(v).length===fields.length&&fields.every(k=>Object.hasOwn(v,k));
}
export function revision(v:unknown):v is number {return typeof v==='number'&&Number.isInteger(v)&&v>=0&&v<=32;}
export function key(v:unknown):v is Key {return typeof v==='string'&&/^k[0-7]$/.test(v);}
export function value(v:unknown):v is Value {return v===null||(typeof v==='string'&&/^[A-Za-z0-9_-]{1,16}$/.test(v));}
export function hash(v:unknown):v is string {return typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);}
export function path(v:unknown):v is string {return typeof v==='string'&&/^[01]{0,3}$/.test(v);}
export function invalid():never {throw new HttpError(400,'invalid_request','Invalid request');}
export function stale():never {throw new HttpError(409,'revision_changed','Revision changed');}
export function capacity():never {throw new HttpError(429,'revision_limit','Revision limit reached');}
export function upstream():never {throw new HttpError(502,'bad_upstream','Invalid or unavailable upstream');}
export function patch(v:unknown):PatchRecord[] {
  if(!Array.isArray(v)||v.length>8) invalid();
  const records:PatchRecord[]=[];
  let previous='';
  for(const r of v) {
    if(!exact(r,['key','value'])||!key(r.key)||!value(r.value)||r.key<=previous) invalid();
    records.push({key:r.key,value:r.value});previous=r.key;
  }
  return records;
}
export function leafHash(k:Key,v:Value):string {
  return createHash('sha256').update(Buffer.from([0])).update(JSON.stringify([k,v])).digest('hex');
}
export function branchHash(left:string,right:string):string {
  return createHash('sha256').update(Buffer.from([1])).update(Buffer.from(left,'hex')).update(Buffer.from(right,'hex')).digest('hex');
}
export function tree(values:readonly Value[]):Map<string,string> {
  if(values.length!==8||!values.every(value)) invalid();
  const nodes=new Map<string,string>();
  KEYS.forEach((k,i)=>nodes.set(i.toString(2).padStart(3,'0'),leafHash(k,values[i]!)));
  for(let depth=2;depth>=0;depth--) for(let i=0;i<2**depth;i++) {
    const p=depth===0?'':i.toString(2).padStart(depth,'0');
    nodes.set(p,branchHash(nodes.get(p+'0')!,nodes.get(p+'1')!));
  }
  return nodes;
}
export async function publicBody(req:IncomingMessage):Promise<unknown> {
  try {return await readJson(req);} catch {return invalid();}
}
export function query(url:URL,fields:readonly string[]):Record<string,string> {
  const entries=[...url.searchParams];
  if(entries.length!==fields.length||fields.some(k=>url.searchParams.getAll(k).length!==1)||entries.some(([k])=>!fields.includes(k))) invalid();
  return Object.fromEntries(entries);
}
export function queryRevision(raw:unknown):number {
  if(typeof raw!=='string'||! /^(0|[1-9]|[12][0-9]|3[0-2])$/.test(raw)) invalid();
  return Number(raw);
}
