import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, numberSetting, serve } from '../../lib/http.mts';
import { fail, listenerIsUpstream, mergeTop, origins, parseQuery, upstreamFailure, validateHost, validateReply } from './ranking.mts';
import type { Item, Origins, Query, Shard } from './ranking.mts';

async function boundedJson(response:Response,signal:AbortSignal):Promise<unknown> {
  if(response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()!=='application/json'||!response.body) upstreamFailure();
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  const cancel=()=>{void reader.cancel().catch(()=>{});};
  signal.addEventListener('abort',cancel,{once:true});
  try {
    while(true) {
      signal.throwIfAborted();const chunk=await reader.read();signal.throwIfAborted();
      if(chunk.done) break;
      size+=chunk.value.byteLength;if(size>8192) upstreamFailure();chunks.push(chunk.value);
    }
    const raw:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));return raw;
  } finally {signal.removeEventListener('abort',cancel);cancel();}
}
export async function aggregate(config:Origins,q:Query,fetcher:typeof fetch=fetch):Promise<{snapshots:{a:number,b:number},items:Item[]}> {
  const controller=new AbortController();
  let timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=new Promise<never>((_resolve,reject)=>{
    timer=setTimeout(()=>{controller.abort();reject(new Error('deadline'));},500);
  });
  const local=async(shard:Shard):Promise<Item[]>=>{
    const response=await fetcher(`${config[shard]}/snapshots/${q[shard]}/top?k=${q.k}`,{method:'GET',redirect:'error',signal:controller.signal});
    const body=await boundedJson(response,controller.signal);
    // Even a recognized unknown_snapshot fails the whole vector. No status is forwarded.
    if(response.status!==200) upstreamFailure();
    return validateReply(body,shard,q[shard],q.k);
  };
  const work=async()=>{
    const [a,b]=await Promise.all([local('a'),local('b')]);
    return {snapshots:{a:q.a,b:q.b},items:mergeTop(a,b,q.k)};
  };
  try {return await Promise.race([work(),deadline]);}
  catch {return upstreamFailure();}
  finally {clearTimeout(timer);controller.abort();}
}
export function queryHandler(config:Origins) {
  const fixed=origins(config.a,config.b);
  return async(req:IncomingMessage,res:ServerResponse):Promise<void>=>{
    const u=new URL(req.url??'/','http://query');
    if(u.pathname!=='/top') fail(404,'not_found');
    if(req.method!=='GET') fail(405,'method_not_allowed');
    json(res,200,await aggregate(fixed,parseQuery(u.searchParams)));
  };
}
export async function main():Promise<void> {
  validateHost(process.env.HOST);
  const a=process.env.SHARD_A_ORIGIN,b=process.env.SHARD_B_ORIGIN;
  if(!a||!b) throw new Error('SHARD_A_ORIGIN and SHARD_B_ORIGIN required');
  const fixed=origins(a,b),port=numberSetting('PORT',3175,0,65535);
  if(listenerIsUpstream(fixed,port)) throw new Error('Query origin must differ from shard origins');
  await serve('sharded-top-k-query',3175,queryHandler(fixed));
}
if(import.meta.main) main().catch((error:unknown)=>{console.error(error instanceof Error?error.message:'Startup failed');process.exitCode=1;});
