import { serve,json,numberSetting } from '../../lib/http.mts';
import { decode,digest,fail,id,integer,record,sha } from './store.mts';
import { bounded } from './wire.mts';
export function validateObject(input:unknown,key:string){const v=record(input);if(id(v.id)!==key)fail(400);const bytes=decode(v.base64,8192),size=integer(v.size,1,8192),hash=sha(v.sha256);if(bytes.length!==size||digest(bytes)!==hash)fail(400);return {id:key,base64:bytes.toString('base64'),size,sha256:hash};}
export async function main(){
 const origin=new URL(process.env.STORE_ORIGIN??'http://127.0.0.1:4343');
 if(origin.protocol!=='http:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw new Error('Invalid STORE_ORIGIN');
 const deadline=numberSetting('UPSTREAM_TIMEOUT_MS',1000,50,5000);
 return serve('reader',4344,async(req,res)=>{
 const match=/^\/objects\/([A-Za-z0-9_-]{1,32})$/.exec(new URL(req.url??'/','http://local').pathname);if(req.method!=='GET'||!match)fail(404);const key=match[1]!;
 let result:ReturnType<typeof validateObject>|undefined;let missing=false;
 try{const response=await fetch(new URL(`/objects/${key}`,origin),{redirect:'error',signal:AbortSignal.timeout(deadline)});if(response.status===404){await response.body?.cancel();missing=true;}else{if(response.status!==200||response.headers.get('content-type')?.split(';')[0]!=='application/json')throw new Error('Provider status');result=validateObject(await bounded(response),key);}}catch{fail(502);}
 if(missing)fail(404);json(res,200,result);
 });
}
if(import.meta.main)await main();
