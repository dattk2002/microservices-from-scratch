import type { IncomingMessage,ServerResponse } from 'node:http';
import { HttpError,json,readJson } from '../../lib/http.mts';
import { Gap } from './model.mts';

export const BODY_BYTES=8192;
// Admission includes requests still reading their bodies. No waiting queue.
export function admitted(handler:(req:IncomingMessage,res:ServerResponse)=>Promise<void>) {
  let active=0;
  return async(req:IncomingMessage,res:ServerResponse)=>{
    if(active>=12) {req.resume();json(res,503,{error:{code:'busy'}});return;}
    active++;
    try {await handler(req,res);}
    catch(error:unknown) {
      if (error instanceof Gap) json(res,409,{error:{code:'gap',expected:error.expected,message:error.message}});
      else if(error instanceof HttpError) json(res,error.status,{error:{code:error.code,message:error.message}});
      else json(res,500,{error:{code:'internal_error'}});
    } finally {active--;}
  };
}
export async function body(req:IncomingMessage,total?:AbortSignal):Promise<unknown> {
  let timer:ReturnType<typeof setTimeout>|undefined;
  let abort:(()=>void)|undefined;
  try {
    return await Promise.race([readJson(req),new Promise<never>((_,reject)=>{
      abort=()=>reject(new HttpError(408,'body_deadline','request body deadline'));
      timer=setTimeout(abort,1000);
      if(total?.aborted)abort();
      else total?.addEventListener('abort',abort,{once:true});
    })]);
  } finally {
    if(timer)clearTimeout(timer);
    if(abort)total?.removeEventListener('abort',abort);
  }
}
export function queryInteger(raw:string|null,min:number,max:number):number {
  if(raw===null || !/^(0|[1-9][0-9]*)$/.test(raw))throw new HttpError(400,'invalid','invalid query');
  const n=Number(raw);
  if(!Number.isSafeInteger(n)||n<min||n>max)throw new HttpError(400,'invalid','invalid query');
  return n;
}
export function origin(value:string|undefined):string {
  const url=new URL(value??'http://127.0.0.1:3037');
  if(url.protocol!=='http:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash)throw new Error('Invalid BROKER_ORIGIN');
  return url.origin;
}
