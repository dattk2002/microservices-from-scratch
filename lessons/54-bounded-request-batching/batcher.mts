import { HttpError } from '../../lib/http.mts';
export type Item = {id:string;found:true;value:number}|{id:string;found:false};
export const failure = (status:number) => new HttpError(status,'lookup_failed',`Lookup failed (${status})`);
export function record(value:unknown): value is Record<string,unknown> {return typeof value === 'object' && value !== null && !Array.isArray(value);}
export function idsFrom(value:unknown,max:number,distinct=false):string[]{
 if(!record(value)||!Array.isArray(value.ids)||value.ids.length<1||value.ids.length>max||!value.ids.every((id:unknown)=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,16}$/.test(id))) throw failure(400);
 const ids:string[]=value.ids;
 if(distinct&&new Set(ids).size!==ids.length) throw failure(400);
 return ids;
}
export function validate(value:unknown,ids:string[]):Item[]{
 if(!record(value)||!Array.isArray(value.items)||value.items.length!==ids.length) throw failure(502);
 const seen=new Set<string>(); const items:Item[]=[];
 for(const v of value.items){
  if(!record(v)||typeof v.id!=='string'||!ids.includes(v.id)||seen.has(v.id)||typeof v.found!=='boolean') throw failure(502);
  seen.add(v.id);
  if(v.found){if(typeof v.value!=='number'||!Number.isInteger(v.value)||v.value<1||v.value>100)throw failure(502);items.push({id:v.id,found:true,value:v.value});}
  else {if('value' in v)throw failure(502);items.push({id:v.id,found:false});}
 }
 return items;
}
type Caller={ids:string[];results:Map<string,Item>;resolve:(items:Item[])=>void;reject:(error:unknown)=>void;cleanup:()=>void};
type Key={callers:Set<Caller>;active:boolean};
type Options={schedule?:(job:()=>void)=>void;timer?:(job:()=>void,ms:number)=>(()=>void)};
export class Batcher {
 private keys=new Map<string,Key>(); private callers=new Set<Caller>();
 private active:{ids:string[];keys:Map<string,Key>;controller:AbortController}|undefined; private scheduled=false; private closed=false;
 private calls=0;private cancelled=0;
 private schedule:(job:()=>void)=>void;private timer:(job:()=>void,ms:number)=>(()=>void);
 private send:(ids:string[],signal:AbortSignal)=>Promise<Item[]>;
 constructor(send:(ids:string[],signal:AbortSignal)=>Promise<Item[]>,options:Options={}){
  this.send=send;
  this.schedule=options.schedule??(job=>{setImmediate(job);});
  this.timer=options.timer??((job,ms)=>{const t=setTimeout(job,ms);return ()=>clearTimeout(t);});
 }
 state(){return {waiters:[...this.callers].reduce((n,c)=>n+c.ids.filter(id=>!c.results.has(id)).length,0),keys:new Set([...this.keys.keys(),...(this.active?.ids??[])]).size,activeBatchSize:this.active?.ids.length??0,upstreamCalls:this.calls,cancelledWaiters:this.cancelled};}
 lookup(ids:string[],signal?:AbortSignal):Promise<Item[]>{
  if(this.closed)return Promise.reject(failure(503));
  if(this.state().waiters+ids.length>16||new Set([...this.keys.keys(),...(this.active?.ids??[]),...ids]).size>8)return Promise.reject(failure(429));
  return new Promise((resolve,reject)=>{
   const c:Caller={ids,results:new Map(),resolve,reject,cleanup:()=>{}};
   this.callers.add(c);
   for(const id of ids){let k=this.keys.get(id);if(!k){k={callers:new Set(),active:false};this.keys.set(id,k);}k.callers.add(c);}
   const cancel=()=>this.finish(c,failure(499),true);
   const clear=this.timer(()=>this.finish(c,failure(504),true),600);
   c.cleanup=()=>{clear();signal?.removeEventListener('abort',cancel);};
   signal?.addEventListener('abort',cancel,{once:true});
   if(signal?.aborted)cancel();
   this.kick();
  });
 }
 private finish(c:Caller,error?:unknown,cancel=false){
  if(!this.callers.delete(c))return;
  if(cancel)this.cancelled=Math.min(65535,this.cancelled+c.ids.filter(id=>!c.results.has(id)).length);
  c.cleanup();
  for(const [id,k] of this.keys){k.callers.delete(c);if(!k.active&&k.callers.size===0)this.keys.delete(id);}
  for(const k of this.active?.keys.values()??[])k.callers.delete(c);
  if(this.active&&[...this.active.keys.values()].every(k=>k.callers.size===0))this.active.controller.abort();
  if(error)c.reject(error);else c.resolve(c.ids.map(id=>{const item=c.results.get(id);if(!item)throw Error('missing result');return item;}));
  this.kick();
 }
 private kick(){if(this.closed||this.active||this.scheduled||!this.keys.size)return;this.scheduled=true;this.schedule(()=>{this.scheduled=false;void this.dispatch();});}
 private async dispatch(){
  if(this.closed||this.active)return;
  const ids=[...this.keys].filter(([,k])=>!k.active&&k.callers.size>0).slice(0,4).map(([id])=>id);if(!ids.length)return;
  const controller=new AbortController();const batchKeys=new Map<string,Key>();
  for(const id of ids){const k=this.keys.get(id);if(k){k.active=true;batchKeys.set(id,k);}}
  this.active={ids,keys:batchKeys,controller};
  // Retire coalescing membership synchronously; the old transport still owns its key objects.
  const retire=()=>{for(const [id,k] of batchKeys)if(this.keys.get(id)===k)this.keys.delete(id);};
  controller.signal.addEventListener('abort',retire,{once:true});
  this.calls=Math.min(65535,this.calls+1);
  const clear=this.timer(()=>controller.abort(),300);
  try{
   const reply=await this.send(ids,controller.signal);if(controller.signal.aborted)throw failure(502);
   const items=validate({items:reply},ids);
   for(const item of items){const k=batchKeys.get(item.id);if(this.keys.get(item.id)===k)this.keys.delete(item.id);for(const c of k?.callers??[]){c.results.set(item.id,item);}}
   for(const c of [...this.callers])if(c.ids.every(id=>c.results.has(id)))this.finish(c);
  }catch{
   const affected=new Set<Caller>();for(const id of ids)for(const c of batchKeys.get(id)?.callers??[])affected.add(c);
   retire();
   for(const c of affected)this.finish(c,failure(502));
  }finally{clear();retire();controller.signal.removeEventListener('abort',retire);this.active=undefined;this.kick();}
 }
 close(){this.closed=true;for(const c of [...this.callers])this.finish(c,failure(503));this.active?.controller.abort();}
}
