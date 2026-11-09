import { serve,json,HttpError } from '../../lib/http.mts';
import { Mirrors,product,compare,object } from './policy.mts';
import { origin,read,control } from './transport.mts';
export async function main() {
  const primary=origin('PRIMARY_ORIGIN'), shadow=origin('SHADOW_ORIGIN');
  const mirrors=new Mirrors(); const shutdown=new AbortController();
  const server=await serve('shadow-gateway',4545,async(req,res)=>{
    const path=req.url ?? '';
    if(path==='/stats' && req.method==='GET') { json(res,200,mirrors.stats()); return; }
    if(path==='/teaching/drain' && req.method==='POST' && process.env.TEACHING_CONTROLS==='1') {
      const body=await control(req);
      if(!object(body) || Object.keys(body).length!==0) throw new HttpError(400,'invalid_control','Expected empty object');
      await mirrors.drain(); json(res,200,mirrors.stats()); return;
    }
    if(path.startsWith('/teaching/')) throw new HttpError(404,'not_found','Not found');
    if(req.rawHeaders.reduce((n,value)=>n+Buffer.byteLength(value),0)>8192) throw new HttpError(431,'headers_large','Header budget');
    const match=/^\/products\/([A-Za-z0-9_-]{1,32})$/.exec(path);
    if(!match) throw new HttpError(400,'invalid_path','Expected product id without query');
    if(req.method!=='GET') throw new HttpError(405,'read_only','Only GET');
    if(req.headers['transfer-encoding'] || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')) throw new HttpError(400,'body_forbidden','GET has no body');
    const id=match[1]!; const deadline=AbortSignal.timeout(700);
    const client=new AbortController();
    const disconnected=()=>{ if(!res.writableFinished) client.abort(); };
    res.once('close',disconnected);
    try {
      const value=product(await read(primary,id,AbortSignal.any([deadline,shutdown.signal,client.signal])),id);
      if(client.signal.aborted) return;
      mirrors.start(async()=>{
        const signal=AbortSignal.any([AbortSignal.timeout(1000),shutdown.signal,client.signal]);
        return compare(value,product(await read(shadow,id,signal),id));
      });
      json(res,200,value);
    } catch { if(!res.destroyed) json(res,deadline.aborted?504:502,{error:'primary_unavailable'}); }
    finally { if(res.destroyed) res.off('close',disconnected); }
  });
  const stop=()=>{shutdown.abort();server.closeAllConnections();};
  process.once('SIGTERM',stop); process.once('SIGINT',stop);
}
if(import.meta.main) await main();
