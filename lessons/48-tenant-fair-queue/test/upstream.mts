// Test-only independent HTTP process: one reusable fixture, bounded control vocabulary.
import { HttpError,json,readJson,serve } from '../../../lib/http.mts';
import { input,object } from '../model.mts';
export async function main(){
 let mode='same';let calls=0;let forwarded=0;const timers=new Set<ReturnType<typeof setTimeout>>();
 const server=await serve('fixture',0,async(req,res)=>{
 if(req.url==='/control'&&req.method==='POST'){
 const x=object(await readJson(req));if(typeof x.mode!=='string'||!['same','identity','invalid','oversized','slow','redirect','unavailable'].includes(x.mode))throw new HttpError(400,'input','mode');
 mode=x.mode;calls=0;forwarded=0;json(res,200,{});return;
 }
 if(req.url==='/state'){json(res,200,{calls,forwarded});return;}
 if(req.url==='/sink'){forwarded++;json(res,200,{tenant:'red',id:'job',result:2});return;}
 if(req.url==='/execute'&&req.method==='POST'){
 const x=input(await readJson(req));calls++;const reply={tenant:x.tenant,id:x.id,result:x.value*2};
 if(mode==='redirect'){res.writeHead(307,{location:`${process.env.REDIRECT_ORIGIN}/execute`});res.end();return;}
 if(mode==='unavailable'){json(res,503,reply);return;}
 if(mode==='identity'){json(res,200,{...reply,id:'other'});return;}
 if(mode==='invalid'){json(res,200,{...reply,result:String(reply.result)});return;}
 if(mode==='oversized'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(reply)+' '.repeat(513));return;}
 if(mode==='slow'){
 res.writeHead(200,{'content-type':'application/json'});res.write(' ');
 const timer=setTimeout(()=>{timers.delete(timer);res.end(JSON.stringify(reply));},1200);timers.add(timer);
 res.once('close',()=>{clearTimeout(timer);timers.delete(timer);});return;
 }
 json(res,200,reply);return;
 }throw new HttpError(404,'route','route');
 });server.once('close',()=>{for(const t of timers)clearTimeout(t);});return server;
}
if(import.meta.main)await main();
