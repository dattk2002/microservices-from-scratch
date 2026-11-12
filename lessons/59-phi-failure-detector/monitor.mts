import { performance } from 'node:perf_hooks';
import { HttpError, json, readJson, serve } from '../../lib/http.mts';
import { object, Tracker } from './tracker.mts';

// 512 bytes includes the fully escaped spellings of both JSON field names.
export async function fetchHeartbeat(origin: string): Promise<unknown> {
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),200);
  try {
    const response=await fetch(`${origin}/heartbeat`,{redirect:'error',signal:controller.signal});
    if(response.status!==200 || !response.body) throw new Error('Upstream status');
    const reader=response.body.getReader();
    const chunks:Uint8Array[]=[]; let bytes=0;
    try {
      for(;;) {
        const part=await reader.read(); if(part.done) break;
        bytes+=part.value.byteLength;
        if(bytes>512) { controller.abort(); throw new Error('Upstream body too large'); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {clearTimeout(timer); controller.abort();}
}
export async function main() {
  const raw=process.env.BEACON_ORIGIN;
  if(!raw) throw new Error('BEACON_ORIGIN required');
  const url=new URL(raw);
  if(url.protocol!=='http:' || url.hostname!=='127.0.0.1' || url.username || url.password || url.pathname!=='/' || url.search || url.hash) throw new Error('Invalid BEACON_ORIGIN');
  const origin=url.origin;
  const teaching=process.env.TEACHING_CONTROLS==='1'; let logical=0; let active=false;
  const now=()=>teaching?logical:Math.floor(performance.now());
  const tracker=new Tracker();
  await serve('monitor',5960,async(req,res)=>{
    if(req.url==='/state' && req.method==='GET') {json(res,200,tracker.state(now()));return;}
    if(req.url==='/teaching/advance' && teaching && req.method==='POST') {
      const body=await readJson(req);
      if(!object(body,['milliseconds']) || typeof body.milliseconds!=='number' || !Number.isInteger(body.milliseconds) || body.milliseconds<1 || body.milliseconds>1000 || logical+body.milliseconds>60000) throw new HttpError(400,'invalid_body','Invalid advance');
      logical+=body.milliseconds;json(res,200,{now:logical});return;
    }
    if(req.url==='/sample' && req.method==='POST') {
      const body=await readJson(req);
      if(!object(body,[])) throw new HttpError(400,'invalid_body','Expected empty object');
      if(active) throw new HttpError(409,'sample_active','Sample already active');
      active=true;
      try {
        const value=await fetchHeartbeat(origin);
        tracker.accept(value,now()); json(res,200,tracker.state(now()));
      } catch {throw new HttpError(502,'invalid_upstream','Heartbeat unavailable or invalid');}
      finally {active=false;}
      return;
    }
    throw new HttpError(404,'not_found','Unknown route');
  });
}
if(import.meta.main) await main();
