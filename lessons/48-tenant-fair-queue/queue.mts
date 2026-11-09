import { DatabaseSync } from 'node:sqlite';
import { HttpError,json,readJson,serve } from '../../lib/http.mts';
import { Permit } from './permit.mts';
import { Queue,object } from './model.mts';
// Stream and deadline cover the entire response body, not only response headers.
export async function dispatch(q:Queue,origin:string):Promise<unknown>{
 const j=q.select();if(!j)return {dispatched:false};
 try{
 const r=await fetch(`${origin}/execute`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tenant:j.tenant,id:j.id,value:j.value}),redirect:'error',signal:AbortSignal.timeout(700)});
 if(!r.ok||!r.body){await r.body?.cancel();throw new Error('upstream status');}
 const reader=r.body.getReader();const chunks:Uint8Array[]=[];let size=0;
 try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>512)throw new Error('reply budget');chunks.push(part.value);}}finally{await reader.cancel();}
 const reply=object(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
 if(reply.tenant!==j.tenant||reply.id!==j.id||typeof reply.result!=='number'||reply.result!==j.value*2)throw new Error('reply contract');
 q.finish(j,true);return {dispatched:true,job:q.snapshot().jobs.find(x=>x.seq===j.seq)};
 }catch{q.finish(j,false);throw new HttpError(502,'executor_failure','Execution unacknowledged');}
}
export async function main(){
 const u=new URL(process.env.EXECUTOR_ORIGIN??'http://127.0.0.1:4841');
 if(u.protocol!=='http:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new Error('Invalid EXECUTOR_ORIGIN');
 const db=new DatabaseSync(process.env.DB_PATH??'tenant-queue.sqlite');const q=new Queue(db);const permit=new Permit();
 try{const server=await serve('tenant-queue',4840,async(req,res)=>{
 if(req.method==='GET'&&req.url==='/state'){json(res,200,{...q.snapshot(),active:permit.active});return;}
 if(req.method==='POST'&&req.url==='/jobs'){json(res,200,q.admit(await readJson(req)));return;}
 if(req.method==='POST'&&req.url==='/dispatch'){
 const body=object(await readJson(req));if(Object.keys(body).length)throw new HttpError(400,'input','Expected empty object');
 json(res,200,await permit.run(()=>dispatch(q,u.origin)));return;
 }throw new HttpError(404,'route','Unknown route');
 });server.once('close',()=>db.close());return server;
 }catch(e){db.close();throw e;}
}
if(import.meta.main)await main();
