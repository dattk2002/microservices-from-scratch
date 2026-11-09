import { HttpError, json, numberSetting, readJson, serve } from '../../lib/http.mts';
import { actor, bad, keys, object, parseState, value } from './model.mts';
import type { Actor } from './model.mts';
// Legal envelopes are <512 bytes, even when every fixed key is JSON-escaped.
export const ENVELOPE_BYTES=2048;
async function envelope(response: Response, expected: Actor) {
  if(!response.ok || !response.body) throw new Error('Upstream status');
  const reader=response.body.getReader(); const chunks: Uint8Array[]=[]; let size=0;
  try { while(true) { const part=await reader.read(); if(part.done) break; size+=part.value.length; if(size>ENVELOPE_BYTES) throw new Error('Upstream too large'); chunks.push(part.value); } }
  finally { await reader.cancel().catch(()=>{}); }
  const o=object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); keys(o,['actor','state','value']);
  if(actor(o.actor)!==expected) throw new Error('Upstream identity');
  const state=parseState(o.state); if(typeof o.value !== 'number' || o.value!==value(state)) throw new Error('Upstream value');
  return state;
}
export async function main() {
  const origin=(name:string)=>{ const raw=process.env[name]; if(!raw) throw new Error(`Missing ${name}`); const u=new URL(raw); if(u.protocol!=='http:' || u.username || u.password || u.pathname!=='/' || u.search || u.hash) throw new Error('Invalid origin'); return u.origin; };
  const origins={a:origin('REPLICA_A_ORIGIN'),b:origin('REPLICA_B_ORIGIN'),c:origin('REPLICA_C_ORIGIN')};
  const deadline=numberSetting('SYNC_TIMEOUT_MS',1000,10,5000);
  await serve('pn-sync',4144,async(req,res)=>{
    if(req.method!=='POST' || req.url!=='/sync') return json(res,404,{error:'not_found'});
    const input=object(await readJson(req)); keys(input,['from','to']); const from=actor(input.from),to=actor(input.to); if(from===to) bad();
    const signal=AbortSignal.timeout(deadline);
    try {
      const state=await envelope(await fetch(`${origins[from]}/state`,{signal,redirect:'error'}),from);
      await envelope(await fetch(`${origins[to]}/merge`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(state),signal,redirect:'error'}),to);
      json(res,200,{from,to});
    } catch { throw new HttpError(502,'sync_failed','Exchange failed; destination may have applied merge'); }
  });
}
if(import.meta.main) await main();
