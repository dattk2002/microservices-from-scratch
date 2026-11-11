import { HttpError,json,readJson,serve,numberSetting } from '../../lib/http.mts';
import { evaluate,parseEnd,parseSnapshot } from './model.mts';
// 12 records: keys at worst escaped as six-byte \\uXXXX tokens. 4096 also leaves whitespace room.
export const SNAPSHOT_BYTES=4096;
export async function snapshot(origin:string,deadlineMs:number) {
  const signal=AbortSignal.timeout(deadlineMs);
  const response=await fetch(`${origin}/buckets`,{redirect:'error',signal});
  try {
    if(response.status!==200) throw new Error('Upstream status');
    const reader=response.body?.getReader();
    if(!reader) throw new Error('Missing body');
    const chunks:Uint8Array[]=[];let bytes=0;
    try {
      while(true) {
        const chunk=await reader.read();
        if(chunk.done) break;
        bytes+=chunk.value.byteLength;
        if(bytes>SNAPSHOT_BYTES) throw new Error('Oversized');
        chunks.push(chunk.value);
      }
      return parseSnapshot(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
    } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
  } finally {await response.body?.cancel().catch(()=>{});}
}
export async function main() {
  const url=new URL(process.env.COLLECTOR_ORIGIN??'http://127.0.0.1:5551');
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash) throw new Error('Invalid COLLECTOR_ORIGIN');
  const origin=url.origin, deadline=numberSetting('DEADLINE_MS',500,20,5000);
  await serve('slo-evaluator',5552,async(req,res)=>{
    if(req.url!=='/evaluate'||req.method!=='POST') {json(res,404,{error:'not_found'});return;}
    const value=await readJson(req);let end;
    try {end=parseEnd(value);} catch {throw new HttpError(400,'invalid_end','Expected integer end 6..12');}
    try {json(res,200,evaluate(await snapshot(origin,deadline),end));}
    catch {throw new HttpError(502,'collector_unavailable','No evaluation report');}
  });
}
if(import.meta.main) await main();
