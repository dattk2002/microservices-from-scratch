// Independent adversarial peer. Never imported by production entrypoints.
import { serve,json,readJson } from '../../../lib/http.mts';
import type { ServerResponse } from 'node:http';
export async function main(){
 let arrived=false,forwarded=0;const waiters:ServerResponse[]=[];let release:(()=>void)|undefined;
 await serve('adversarial-wallet',0,async(req,res)=>{
 if(req.url==='/arrived'){if(arrived)json(res,200,{ok:true});else waiters.push(res);return;}
 if(req.url==='/count'){json(res,200,{forwarded});return;}
 if(req.url==='/sink'){forwarded++;json(res,503,{});return;}
 if(req.url==='/release'){release?.();json(res,200,{});return;}
 const b=await readJson(req);
 if(req.url==='/try'){
 arrived=true;for(const waiter of waiters)json(waiter,200,{ok:true});waiters.length=0;
 if(process.env.MODE==='barrier')await new Promise<void>(resolve=>{release=resolve;const timer=setTimeout(resolve,1500);timer.unref();res.once('close',()=>{clearTimeout(timer);resolve();});});
 }
 if(process.env.MODE==='redirect'){
 const address=req.headers.host;if(!address)throw new Error('host');
 res.writeHead(307,{location:`http://${address}/sink`});res.end();return;
 }
 if(process.env.MODE==='oversized'){
 // Legal matching reply except the 1024-byte bound: deleting the gate accepts Try and commits.
 const payload=typeof b==='object'&&b!==null?b:{};
 json(res,200,{...payload,resource:'wallet',status:req.url==='/try'?'held':req.url==='/confirm'?'confirmed':'cancelled',padding:'x'.repeat(1100)});return;
 }
 json(res,200,{resource:'wallet',id:42,units:1,status:'held'});
 });
}
if(import.meta.main)await main();
