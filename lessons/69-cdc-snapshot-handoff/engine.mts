import { ReplicaStore } from './store.mts';
import { HttpError } from '../../lib/http.mts';
import { fail, sourceError } from './protocol.mts';
import type { State } from './protocol.mts';

async function readSource(origin:string,path:string,deadline:number,fetcher:typeof fetch,now:()=>number):Promise<unknown> {
 const remaining=deadline-now();if(remaining<=0)fail(504,'upstream_timeout');
 const controller=new AbortController();
 let timer:ReturnType<typeof setTimeout>|undefined;
 const timeout=new Promise<never>((_resolve,reject)=>{
  timer=setTimeout(()=>{
   controller.abort();reject(new HttpError(504,'upstream_timeout','Source deadline exceeded'));
  },Math.ceil(remaining));
 });
 const work=async():Promise<unknown>=>{
  const response=await fetcher(origin+path,{redirect:'error',signal:controller.signal});
  if(response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()!=='application/json')fail(502,'upstream_failure');
  const reader=response.body?.getReader();if(!reader)fail(502,'upstream_failure');
  const chunks:Uint8Array[]=[];let size=0;
  try {
   while(true) {
    const {done,value}=await reader.read();if(done)break;
    size+=value.byteLength;if(size>8192)fail(502,'upstream_failure');chunks.push(value);
   }
  } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
  const body:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(response.status!==200)sourceError(body,response.status,path);
  return body;
 };
 try {return await Promise.race([work(),timeout]);}
 catch(error){
  if(controller.signal.aborted||now()>=deadline)fail(504,'upstream_timeout');
  if(error instanceof HttpError)throw error;fail(502,'upstream_failure');
 } finally {clearTimeout(timer);controller.abort();}
}

export class Replica {
 readonly store:ReplicaStore;
 readonly fetcher:typeof fetch;
 readonly now:()=>number;
 private busy=false;
 constructor(store:ReplicaStore,fetcher:typeof fetch=fetch,now:()=>number=()=>performance.now()) {
  this.store=store;this.fetcher=fetcher;this.now=now;
 }
 // The HTTP handler also holds a gate while reading inbound bytes. This gate
 // protects direct engine callers and is released on every upstream failure.
 private async exclusive(work:()=>Promise<State>):Promise<State> {
  if(this.busy)fail(503,'busy');this.busy=true;
  try{return await work();}finally{this.busy=false;}
 }
 async bootstrap(deadline=this.now()+500):Promise<State> {
  return this.exclusive(async()=>{
   if(this.store.state().phase==='ready')return this.store.state();
   const body=await readSource(this.store.origin,'/snapshot',deadline,this.fetcher,this.now);
   if(this.now()>=deadline)fail(504,'upstream_timeout');
   return this.store.bootstrap(body);
  });
 }
 async pump(deadline=this.now()+500):Promise<State> {
  return this.exclusive(async()=>{
   const state=this.store.state();if(state.phase!=='ready')fail(409,'not_bootstrapped');
   const body=await readSource(this.store.origin,`/changes?after=${state.checkpoint}`,deadline,this.fetcher,this.now);
   if(this.now()>=deadline)fail(504,'upstream_timeout');
   return this.store.apply(body);
  });
 }
}
