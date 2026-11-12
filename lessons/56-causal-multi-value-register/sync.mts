import { serve,json,readJson,HttpError } from '../../lib/http.mts';
import { actor,object,validateState } from './model.mts';
// Two siblings, 32 characters each, all string tokens escaped as six bytes: < 2048.
export const WIRE_LIMIT=2048;
export function origin(raw:string|undefined):string {
 if(!raw)throw new Error('Origin required');const u=new URL(raw);
 if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new Error('Expected loopback origin');return u.origin;
}
export async function snapshot(response:Response):Promise<unknown>{
 if(!response.body)throw new Error('Missing body');const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
 try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>WIRE_LIMIT)throw new Error('Oversize snapshot');chunks.push(value);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function main(){
 const a=origin(process.env.A_ORIGIN),b=origin(process.env.B_ORIGIN);if(a===b)throw new Error('Distinct origins required');
 return serve('register-sync',5657,async(req,res)=>{
 if(req.method!=='POST'||req.url!=='/sync')throw new HttpError(404,'not_found','Unknown route');
 const from=actor(object(await readJson(req),['from']).from);
 const signal=AbortSignal.timeout(300);
 try {
 const source=await fetch((from==='a'?a:b)+'/value',{signal,redirect:'error'});
 if(source.status!==200){await source.body?.cancel();throw new Error('Source status');}
 const state=validateState(await snapshot(source));
 const target=await fetch((from==='a'?b:a)+'/merge',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(state),signal,redirect:'error'});
 if(target.status===409){
 const envelope=object(await snapshot(target),['error']);const error=object(envelope.error,['code','message']);
 if(error.code!=='register_error'||error.message!=='Invalid or conflicting register operation')throw new Error('Invalid conflict reply');
 signal.throwIfAborted();return json(res,409,{error:'target_conflict'});
 }
 if(target.status!==200){await target.body?.cancel();throw new Error('Target status');}
 const result=validateState(await snapshot(target));signal.throwIfAborted();return json(res,200,result);
 }catch {throw new HttpError(502,'sync_failed','Upstream failed; merge may already have committed');}
 });
}
if(import.meta.main)await main();
