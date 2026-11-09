import { HttpError,json,readJson,serve } from '../../lib/http.mts';
import { input,object } from './model.mts';
export async function main(){
 const teaching=process.env.TEACHING_CONTROLS==='1';let mode:'same'|'unavailable'='same';let hold=false;let release:(()=>void)|undefined;
 const server=await serve('executor',4841,async(req,res)=>{
 if(teaching&&req.method==='GET'&&req.url==='/teaching/state'){json(res,200,{held:release!==undefined});return;}
 if(teaching&&req.method==='POST'&&req.url==='/teaching/behavior'){
 const x=object(await readJson(req));if(typeof x.mode!=='string'||(x.mode!=='same'&&x.mode!=='unavailable'))throw new HttpError(400,'input','Invalid mode');mode=x.mode;json(res,200,{mode});return;}
 if(teaching&&req.method==='POST'&&req.url==='/teaching/hold'){
 const x=object(await readJson(req));if(typeof x.enabled!=='boolean')throw new HttpError(400,'input','Invalid enabled');hold=x.enabled;if(!hold)release?.();json(res,200,{enabled:hold});return;}
 if(req.method==='POST'&&req.url==='/execute'){
 const x=input(await readJson(req));
 if(hold){if(release)throw new HttpError(409,'held','One held reply maximum');await new Promise<void>(resolve=>{
 const done=()=>{clearTimeout(timer);res.off('close',done);release=undefined;resolve();};const timer=setTimeout(done,1000);release=done;res.once('close',done);
 });}
 if(res.destroyed)return;
 if(mode==='unavailable')throw new HttpError(503,'unavailable','Teaching failure');
 json(res,200,{tenant:x.tenant,id:x.id,result:x.value*2});return;
 }throw new HttpError(404,'route','Unknown route');
 });server.once('close',()=>release?.());return server;
}
if(import.meta.main)await main();
