import { decisionReply, fail, origins, voteReply } from './protocol.mts';
import type { Origins, ParticipantId, Tuple, Transaction } from './protocol.mts';
import { CoordinatorStore } from './store.mts';

export type Exchange = (origin:string,path:'/prepare'|'/decide',body:Tuple & {decision?:'commit'|'abort'})=>Promise<unknown>;
// One deadline covers connection, headers AND the complete body. All accepted string
// tokens can be maximally \u escaped within 1024 bytes; whitespace is also bounded.
export const exchange:Exchange=async(origin,path,body)=>{
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),500);
 let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
 try{
  const response=await fetch(origin+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:controller.signal});
  if(response.status!==200||response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()!=='application/json'||!response.body)throw new Error('Unexpected upstream response');
  reader=response.body.getReader();const chunks:Uint8Array[]=[];let bytes=0;
  while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>1024)throw new Error('Upstream body too large');chunks.push(part.value);}
  const value:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));return value;
 }finally{
  controller.abort();clearTimeout(timer);
  if(reader){try{await reader.cancel();}catch{/* aborted connection */}reader.releaseLock();}
 }
};
export class Coordinator {
 readonly store:CoordinatorStore;
 readonly targets:Origins;
 readonly send:Exchange;
 private readonly active=new Set<string>();
 constructor(store:CoordinatorStore,targets:Origins,send:Exchange=exchange) {
  this.targets=origins(targets.a,targets.b);this.store=store;this.send=send;
 }
 private async exclusive(txId:string,work:()=>Promise<Transaction>) {
  if(this.active.has(txId))fail(409,'busy');this.active.add(txId);
  try{return await work();}finally{this.active.delete(txId);}
 }
 step(txId:string) {
  return this.exclusive(txId,async()=>{
   const t=this.store.get(txId);if(t.phase!=='preparing')return t;
   const id:ParticipantId=t.votes.a===null?'a':'b';
   let vote:'yes'|'no';
   try{
    const result=await this.send(this.targets[id],'/prepare',{txId,amount:t.amount});
    if(!voteReply(result,t))throw new Error('Invalid vote');vote=result.vote;
   }catch{
    this.store.abort(txId);fail(502,'upstream_failure');
   }
   return this.store.vote(txId,id,vote);
  });
 }
 deliver(txId:string) {
  return this.exclusive(txId,async()=>{
   const t=this.store.get(txId);if(t.phase==='preparing')fail(409,'undecided');
   if(t.acks.a&&t.acks.b)return t;
   const id:ParticipantId=t.acks.a?'b':'a';
   try{
    const result=await this.send(this.targets[id],'/decide',{txId,amount:t.amount,decision:t.phase});
    if(!decisionReply(result,t,t.phase))throw new Error('Invalid decision receipt');
   }catch{fail(502,'upstream_failure');}
   return this.store.ack(txId,id);
  });
 }
}
