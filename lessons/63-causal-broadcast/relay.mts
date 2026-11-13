import { HttpError, json, readJson, serve } from '../../lib/http.mts';
import { exact, fail, integer, isEvent, member, messages } from './core.mts';
import type { Member, Event } from './core.mts';

export const WIRE_LIMIT=2048;
type Reply={status:number;body:unknown};
type Input={from:Member;to:Member;sender:Member;seq:number};
export function origins(a:unknown,b:unknown,c:unknown):Record<Member,string> {
  function normalize(raw:unknown) {
    if(typeof raw!=='string') throw new Error('Missing configured origin');
    const u=new URL(raw);
    if(u.protocol!=='http:' || u.username || u.password || u.pathname!=='/' || u.search || u.hash) throw new Error('Expected plain HTTP origin');
    return u.origin;
  }
  const result={a:normalize(a),b:normalize(b),c:normalize(c)};
  if(new Set(Object.values(result)).size!==3) throw new Error('Origins must be pairwise distinct');
  return result;
}
export function relayInput(body:unknown):Input {
  if(!exact(body,['from','to','sender','seq']) || !member(body.from) || !member(body.to) || body.from===body.to || !member(body.sender) || !integer(body.seq,1,8)) fail(400,'invalid_request');
  return {from:body.from,to:body.to,sender:body.sender,seq:body.seq};
}
function errorEnvelope(body:unknown,code:keyof typeof messages) {
  return exact(body,['error']) && exact(body.error,['code','message']) && body.error.code===code && body.error.message===messages[code];
}
export function sourceReply(status:number,body:unknown,sender:Member,seq:number):Event|Reply {
  if(status===200 && isEvent(body) && body.sender===sender && body.seq===seq) return body;
  if(status===404 && errorEnvelope(body,'unknown_event')) return {status,body};
  return fail(502,'upstream_failure');
}
export function destinationReply(status:number,body:unknown):Reply {
  if(exact(body,['status']) && (status===200 && (body.status==='delivered'||body.status==='buffered') || status===202 && body.status==='buffered')) return {status,body};
  if(status===409 && errorEnvelope(body,'event_conflict') || status===429 && errorEnvelope(body,'buffer_full')) return {status,body};
  return fail(502,'upstream_failure');
}
async function bounded(response:Response,signal:AbortSignal):Promise<unknown> {
  if(response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()!=='application/json') throw new Error('Expected JSON');
  const reader=response.body?.getReader();
  if(!reader) throw new Error('Missing body');
  const chunks:Uint8Array[]=[]; let size=0;
  try {
    for(;;) {
      signal.throwIfAborted();
      const part=await reader.read();
      if(part.done) break;
      size+=part.value.byteLength;
      if(size>WIRE_LIMIT) throw new Error('Upstream body exceeds wire budget');
      chunks.push(part.value);
    }
    signal.throwIfAborted();
    const value:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return value;
  } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function forward(input:Input,fixed:Record<Member,string>):Promise<Reply> {
  const controller=new AbortController();
  const deadline=performance.now()+500;
  const timer=setTimeout(()=>controller.abort(),500);
  const signal=controller.signal;
  try {
    const source=await fetch(`${fixed[input.from]}/events/${input.sender}/${input.seq}`,{redirect:'error',signal});
    const sourceBody=await bounded(source,signal);
    if(performance.now()>=deadline) throw new Error('Deadline');
    const e=sourceReply(source.status,sourceBody,input.sender,input.seq);
    if('status' in e) return e;
    if(performance.now()>=deadline) throw new Error('Deadline');
    const target=await fetch(`${fixed[input.to]}/receive`,{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(e),redirect:'error',signal,
    });
    const body=await bounded(target,signal);
    if(performance.now()>=deadline) throw new Error('Deadline');
    return destinationReply(target.status,body);
  } catch {return fail(502,'upstream_failure');}
  finally {clearTimeout(timer);controller.abort();}
}
export async function main() {
  const fixed=origins(process.env.A_ORIGIN,process.env.B_ORIGIN,process.env.C_ORIGIN);
  return serve('causal-relay',4063,async(req,res)=>{
    if(req.method==='POST'&&req.url==='/relay') {
      const input=relayInput(await readJson(req));
      const result=await forward(input,fixed);json(res,result.status,result.body);return;
    }
    throw new HttpError(404,'not_found','Unknown route');
  });
}
if(import.meta.main) await main();
