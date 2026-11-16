import type { IncomingMessage, ServerResponse } from 'node:http';
import { serve, json, HttpError, methodNotAllowed, numberSetting } from '../../lib/http.mts';
import { exact, revision, key, value, validFilter, mayContain, knownError, semantic, invalid, routeRevision, validateHost } from './protocol.mts';

export function normalizeOrigin(raw:string):string {
  const u=new URL(raw);
  if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password||u.pathname!=='/'||u.search||u.hash||!u.port||Number(u.port)===0) throw new Error('CATALOG_ORIGIN must be a loopback HTTP origin with an explicit nonzero port');
  return u.origin;
}
function failure():never {return semantic(502,'upstream_failure');}
async function body(response:Response,signal:AbortSignal):Promise<unknown> {
  if(response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()!=='application/json'||!response.body) failure();
  const reader=response.body.getReader();
  const chunks:Uint8Array[]=[];let bytes=0;
  const cancel=()=>{void reader.cancel().catch(()=>{});};
  signal.addEventListener('abort',cancel,{once:true});
  try {
    while(true) {
      signal.throwIfAborted();const chunk=await reader.read();signal.throwIfAborted();
      if(chunk.done) break;
      bytes+=chunk.value.byteLength;if(bytes>8192) failure();chunks.push(chunk.value);
    }
    const wire=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
    const parsed:unknown=JSON.parse(wire);return parsed;
  } finally {signal.removeEventListener('abort',cancel);cancel();}
}
type Result={status:200|404,body:{revision:number,key:string,source:'filter'|'catalog',value:string|null}};
export async function lookup(origin:string,r:unknown,k:unknown,fetcher:typeof fetch=fetch):Promise<Result> {
  if(!revision(r)||!key(k)) invalid();
  const base=normalizeOrigin(origin),controller=new AbortController();
  let timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=new Promise<never>((_resolve,reject)=>{
    timer=setTimeout(()=>{controller.abort();reject(new Error('deadline'));},500);
  });
  const work=async():Promise<Result>=>{
    const request=async(path:string)=>{
      const response=await fetcher(base+path,{method:'GET',redirect:'error',signal:controller.signal});
      const parsed=await body(response,controller.signal);return {status:response.status,parsed};
    };
    const f=await request(`/filter/${r}`);
    if(f.status===404&&knownError(f.parsed,'unknown_snapshot')) semantic(404,'unknown_snapshot');
    if(f.status!==200||!validFilter(f.parsed,r)) failure();
    if(!mayContain(f.parsed.bits,k)) return {status:404,body:{revision:r,key:k,source:'filter',value:null}};
    const item=await request(`/snapshots/${r}/items/${k}`);
    if(item.status===404&&knownError(item.parsed,'unknown_snapshot')) semantic(404,'unknown_snapshot');
    if(item.status===404&&knownError(item.parsed,'absent')) return {status:404,body:{revision:r,key:k,source:'catalog',value:null}};
    if(item.status!==200||!exact(item.parsed,['revision','key','value'])||item.parsed.revision!==r||item.parsed.key!==k||!value(item.parsed.value)) failure();
    return {status:200,body:{revision:r,key:k,source:'catalog',value:item.parsed.value}};
  };
  try {return await Promise.race([work(),deadline]);}
  catch(error) {
    if(error instanceof HttpError&&error.status===404&&error.code==='unknown_snapshot') throw error;
    return failure();
  } finally {clearTimeout(timer);controller.abort();}
}
export function lookupHandler(origin:string) {
  const base=normalizeOrigin(origin);
  return async(req:IncomingMessage,res:ServerResponse):Promise<void>=>{
    const u=new URL(req.url??'/','http://lookup'),parts=u.pathname.split('/');
    if(parts.length!==4||parts[1]!=='lookup') throw new HttpError(404,'not_found','not_found');
    if(req.method!=='GET') methodNotAllowed(res,'GET');
    if(u.search!=='') invalid();
    const r=routeRevision(parts[2]);if(!key(parts[3])) invalid();
    const result=await lookup(base,r,parts[3]);json(res,result.status,result.body);
  };
}
export async function main():Promise<void> {
  const raw=process.env.CATALOG_ORIGIN;if(!raw) throw new Error('CATALOG_ORIGIN required');
  const origin=configuredOrigin(raw,process.env.HOST,numberSetting('PORT',3168,0,65535));
  await serve('bloom-lookup',3168,lookupHandler(origin));
}
if(import.meta.main) main().catch((error:unknown)=>{console.error(error instanceof Error?error.message:'Startup failed');process.exitCode=1;});

export function configuredOrigin(raw:string,host:unknown,port:number):string {
  validateHost(host);
  const origin=normalizeOrigin(raw);
  if(port!==0&&origin===`http://127.0.0.1:${port}`) throw new Error('Catalog and lookup origins must be distinct');
  return origin;
}
