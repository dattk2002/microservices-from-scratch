import { HttpError, json, readJson, serve } from '../../lib/http.mts';
import { exact, invalid, invariantError, isInvariantError, origin, parseEnvelope, replica } from './model.mts';

// <1024 bytes even if every legal string character (including keys) uses \uXXXX.
// 2048 gives whitespace headroom; unlimited whitespace is deliberately not accepted.
export const UPSTREAM_BYTES=2048;
export async function readReply(response:Response,signal:AbortSignal):Promise<unknown> {
  if(response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()!=='application/json' || !response.body) throw new Error('Expected JSON body');
  const reader=response.body.getReader(); const chunks:Uint8Array[]=[]; let size=0;
  try {
    while(true) {
      signal.throwIfAborted();
      const part=await reader.read();
      if(part.done) break;
      size+=part.value.byteLength;
      if(size>UPSTREAM_BYTES) throw new Error('Upstream body too large');
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(()=>{}); }
  signal.throwIfAborted();
  const value:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return value;
}
export async function main() {
  const origins={a:origin(process.env.A_ORIGIN),b:origin(process.env.B_ORIGIN)};
  if(origins.a===origins.b) throw new Error('Distinct origins required');
  return serve('escrow-sync',4163,async(req,res)=>{
    if(req.method!=='POST' || req.url!=='/sync') return json(res,404,{error:{code:'not_found',message:'Route not found'}});
    const body=await readJson(req);
    if(!exact(body,['from'])) return invalid();
    const from=replica(body.from),to=from==='a'?'b':'a';
    // One absolute budget includes both fetches and both complete response bodies.
    const signal=AbortSignal.timeout(500);
    try {
      const source=await fetch(`${origins[from]}/state`,{signal,redirect:'error'});
      const sourceBody=await readReply(source,signal);
      if(source.status!==200) throw new Error('Unexpected source status');
      const state=parseEnvelope(sourceBody,from);
      const target=await fetch(`${origins[to]}/merge`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(state.snapshot),signal,redirect:'error'});
      const targetBody=await readReply(target,signal);
      if(target.status===409 && isInvariantError(targetBody)) return json(res,409,invariantError);
      if(target.status!==200) throw new Error('Unexpected target status');
      const result=parseEnvelope(targetBody,to);
      signal.throwIfAborted();
      json(res,200,result);
    } catch { throw new HttpError(502,'sync_failed','Sync failed; target commit may be uncertain'); }
  });
}
if(import.meta.main) await main();
