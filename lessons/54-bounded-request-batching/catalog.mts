import { json,readJson,serve } from '../../lib/http.mts';
import { failure,idsFrom,record } from './batcher.mts';
export async function main(){
 const controls=process.env.TEACHING_CONTROLS==='1';
 let mode:'normal'|'unavailable'='normal',hold=false,calls=0,active=0,maxConcurrent=0,lastIds:string[]=[];
 let release:(()=>void)|undefined;
 const server=await serve('batch-catalog',5401,async(req,res)=>{
  if(controls&&req.method==='GET'&&req.url==='/teaching/state'){json(res,200,{calls,lastIds,maxConcurrent,active});return;}
  if(controls&&req.method==='POST'&&(req.url==='/teaching/hold'||req.url==='/teaching/behavior')){
   const body=await readJson(req);if(!record(body))throw failure(400);
   if(req.url==='/teaching/hold'){if(typeof body.enabled!=='boolean')throw failure(400);hold=body.enabled;if(!hold)release?.();}
   else{if(typeof body.mode!=='string'||!['normal','unavailable'].includes(body.mode))throw failure(400);mode=body.mode==='normal'?'normal':'unavailable';}
   json(res,200,{ok:true});return;
  }
  if(req.method!=='POST'||req.url!=='/batch'){json(res,404,{});return;}
  const ids=idsFrom(await readJson(req),4,true);calls=Math.min(65535,calls+1);lastIds=ids;active++;maxConcurrent=Math.min(65535,Math.max(maxConcurrent,active));
  try{
   if(hold){if(release)throw failure(503);await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);res.off('close',done);release=undefined;resolve();};const timer=setTimeout(done,800);release=done;res.once('close',done);});}
   if(res.destroyed)return;
   if(mode==='unavailable')throw failure(503);
   json(res,200,{items:ids.slice().reverse().map(id=>{const index=['a','b','c','d','e','f','g','h'].indexOf(id);return index<0?{id,found:false}:{id,found:true,value:(index+1)*10};})});
  }finally{active--;}
 });
 server.once('close',()=>release?.());process.once('SIGTERM',()=>release?.());process.once('SIGINT',()=>release?.());return server;
}
if(import.meta.main)await main();
