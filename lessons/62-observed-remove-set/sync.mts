import { HttpError, json, readJson, serve } from '../../lib/http.mts';
import { actor, object, parseSnapshot } from './state.mts';
// 8192 also admits the maximum snapshot with every JSON string character escaped.
export const WIRE_BYTES=8192;
export function origins(a: string | undefined,b: string | undefined): {a:string;b:string} {
  function normalize(raw: string | undefined): string {
    if (!raw) throw new Error('Missing origin');
    const url=new URL(raw);
    if(url.protocol!=='http:' || url.hostname!=='127.0.0.1' || url.username || url.password || url.pathname!=='/' || url.search || url.hash) throw new Error('Expected loopback HTTP origin');
    return url.origin;
  }
  const aa=normalize(a),bb=normalize(b);
  if(aa===bb) throw new Error('Origins must be distinct');
  return {a:aa,b:bb};
}
async function body(response: Response): Promise<unknown> {
  if(response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()!=='application/json') throw new Error('Expected JSON');
  if(!response.body) throw new Error('Missing body');
  const reader=response.body.getReader(); const chunks: Uint8Array[]=[]; let size=0;
  try {
    while(true) {
      const part=await reader.read(); if(part.done) break;
      size+=part.value.byteLength;
      if(size>WIRE_BYTES) throw new Error('Upstream body too large');
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch(error) { await reader.cancel().catch(()=>{}); throw error; }
  finally { reader.releaseLock(); }
}
function conflict(value: unknown): boolean {
  return object(value,['error']) && object(value.error,['code','message']) && value.error.code==='conflicting_tag' && value.error.message==='Tag already names another element';
}
export async function synchronize(from: 'a'|'b', peers: {a:string;b:string}): Promise<{status:number;value:unknown}> {
  const controller=new AbortController();
  const deadline=setTimeout(()=>controller.abort(),500);
  try {
    const source=await fetch(peers[from]+'/state',{redirect:'error',signal:controller.signal});
    const state=parseSnapshot(await body(source));
    if(source.status!==200) throw new Error('Unexpected source status');
    const payload=JSON.stringify(state);
    if(Buffer.byteLength(payload)>WIRE_BYTES) throw new Error('Outbound body too large');
    const target=await fetch(peers[from==='a'?'b':'a']+'/merge',{method:'POST',headers:{'content-type':'application/json'},body:payload,redirect:'error',signal:controller.signal});
    const value=await body(target);
    if(target.status===409 && conflict(value)) return {status:409,value};
    if(target.status!==200) throw new Error('Unexpected target status');
    return {status:200,value:parseSnapshot(value)};
  } catch { throw new HttpError(502,'bad_upstream','Upstream exchange failed'); }
  finally { clearTimeout(deadline); controller.abort(); }
}
export async function main() {
  const peers=origins(process.env.A_ORIGIN,process.env.B_ORIGIN);
  return serve('orset-sync',6264,async(req,res)=>{
    if(req.method!=='POST' || req.url!=='/sync') throw new HttpError(404,'not_found','Route not found');
    const input=await readJson(req);
    if(!object(input,['from']) || !actor(input.from)) throw new HttpError(400,'invalid_body','Invalid request body');
    const result=await synchronize(input.from,peers); json(res,result.status,result.value);
  });
}
if(import.meta.main) main().catch((error:unknown)=>{console.error(error instanceof Error?error.message:'Startup failed');process.exitCode=1;});
