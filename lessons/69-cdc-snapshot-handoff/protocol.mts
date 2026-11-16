import { HttpError } from '../../lib/http.mts';

export type Item = {key:string; value:string};
export type Change = {seq:number; key:string; value:string|null};
export type Snapshot = {through:number; items:Item[]};
export type Batch = {after:number; through:number; changes:Change[]};
export type State = {checkpoint:number; phase:'empty'|'ready'; items:Item[]};
const messages:Record<string,string> = {
 invalid_body:'Invalid request schema', absent:'Item is absent', capacity:'Change log is full',
 cursor_ahead:'Cursor exceeds source highwater', not_bootstrapped:'Bootstrap is required',
 busy:'Replica operation in progress', upstream_failure:'Invalid source response',
 upstream_timeout:'Source deadline exceeded', request_timeout:'Request body deadline exceeded', not_found:'Unknown route',
};
export function fail(status:number,code:string):never { throw new HttpError(status,code,messages[code]??code); }
function isRecord(value:unknown):value is Record<string,unknown> {
 return typeof value==='object'&&value!==null&&!Array.isArray(value);
}
export function fields(value:unknown,names:readonly string[]):Record<string,unknown> {
 if(!isRecord(value))fail(400,'invalid_body');
 const keys=Object.keys(value);
 if(keys.length!==names.length||!names.every(name=>Object.hasOwn(value,name)))fail(400,'invalid_body');
 return value;
}
export function key(value:unknown):string {
 if(typeof value!=='string'||!/^k[0-7]$/.test(value))fail(400,'invalid_body');return value;
}
export function itemValue(value:unknown):string {
 if(typeof value!=='string'||! /^[A-Za-z]{1,24}$/.test(value))fail(400,'invalid_body');return value;
}
export function cursor(value:unknown):number {
 if(typeof value!=='number'||!Number.isInteger(value)||value<0||value>32)fail(400,'invalid_body');return value;
}
export function sourceOrigin(value:unknown):string {
 if(typeof value!=='string')throw new Error('SOURCE_ORIGIN required');
 const url=new URL(value);
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.port==='0')throw new Error('Invalid loopback SOURCE_ORIGIN');
 return url.origin;
}
function upstream<T>(work:()=>T):T { try{return work();}catch{fail(502,'upstream_failure');} }
export function snapshot(value:unknown):Snapshot {
 return upstream(()=>{
  const body=fields(value,['through','items']);const through=cursor(body.through);
  if(!Array.isArray(body.items)||body.items.length>8||body.items.length>through)fail(400,'invalid_body');
  let previous='';
  const items=body.items.map((entry:unknown)=>{
   const row=fields(entry,['key','value']);const k=key(row.key);const v=itemValue(row.value);
   if(k<=previous)fail(400,'invalid_body');previous=k;return {key:k,value:v};
  });
  return {through,items};
 });
}
export function batch(value:unknown,after:number):Batch {
 return upstream(()=>{
  const body=fields(value,['after','through','changes']);
  if(cursor(body.after)!==after)fail(400,'invalid_body');
  const through=cursor(body.through);
  if(through<after||!Array.isArray(body.changes)||body.changes.length>4)fail(400,'invalid_body');
  let next=after+1;
  const changes=body.changes.map((entry:unknown)=>{
   const row=fields(entry,['seq','key','value']);const seq=cursor(row.seq);
   if(seq!==next++||seq>through)fail(400,'invalid_body');
   return {seq,key:key(row.key),value:row.value===null?null:itemValue(row.value)};
  });
  if((changes.length===0)!==(after===through))fail(400,'invalid_body');
  return {after,through,changes};
 });
}
// Only /changes defines a status-preserving source error. A well-shaped
// internal_error is not evidence of a business rejection.
export function sourceError(value:unknown,status:number,path:string):never {
 const valid=upstream(()=>{
  const body=fields(value,['error']);const error=fields(body.error,['code','message']);
  return status===409&&path.startsWith('/changes?')&&error.code==='cursor_ahead'&&error.message===messages.cursor_ahead;
 });
 if(valid)fail(409,'cursor_ahead');fail(502,'upstream_failure');
}
