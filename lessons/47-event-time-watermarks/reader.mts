import { HttpError, json, serve } from '../../lib/http.mts';
import { parseSnapshot } from './store.mts';
export async function readSnapshot(origin:string) {
  const response=await fetch(`${origin}/state`,{redirect:'error',signal:AbortSignal.timeout(700)});
  if(!response.ok || !response.body) throw new Error('Upstream status');
  const chunks:Uint8Array[]=[]; let size=0;
  const reader=response.body.getReader();
  try {
    while(true) {
      const chunk=await reader.read(); if(chunk.done) break;
      size+=chunk.value.byteLength;
      if(size>8192) throw new Error('Snapshot too large');
      chunks.push(chunk.value);
    }
    return parseSnapshot(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
  } finally {await reader.cancel();}
}
export async function main() {
  const url=new URL(process.env.AGGREGATOR_ORIGIN ?? 'http://127.0.0.1:4740');
  if(url.protocol!=='http:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash) throw new Error('Invalid AGGREGATOR_ORIGIN');
  const origin=url.origin;
  await serve('window-reader',4741,async(req,res)=> {
    if(req.method!=='GET' || req.url!=='/windows') throw new HttpError(404,'not_found','Unknown route');
    try {const state=await readSnapshot(origin);json(res,200,{global:state.global,windows:state.windows});}
    catch {throw new HttpError(502,'invalid_upstream','Complete bounded snapshot required');}
  });
}
if(import.meta.main) await main();
