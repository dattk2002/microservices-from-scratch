import { serve,json,HttpError } from '../../lib/http.mts';
import { object } from './policy.mts';
import { control } from './transport.mts';
export async function main() {
  const variant=process.env.VARIANT ?? 'primary';
  if(variant!=='primary' && variant!=='shadow') throw new Error('Invalid VARIANT');
  let mode='same', hold=false, calls=0; const held=new Set<()=>void>();
  const release=()=>{for(const done of held) done();};
  const server=await serve(variant,variant==='primary'?4546:4547,async(req,res)=>{
    if(process.env.TEACHING_CONTROLS==='1' && req.url?.startsWith('/teaching/')) {
      if(req.url==='/teaching/state' && req.method==='GET') {json(res,200,{calls,held:held.size});return;}
      if(req.method!=='POST') throw new HttpError(405,'method','POST required');
      const body=await control(req);
      if(!object(body)) throw new HttpError(400,'invalid_control','Object required');
      if(req.url==='/teaching/behavior' && Object.keys(body).length===1 && typeof body.mode==='string' && ['same','different','unavailable'].includes(body.mode)) mode=body.mode;
      else if(req.url==='/teaching/hold' && Object.keys(body).length===1 && typeof body.enabled==='boolean') {hold=body.enabled;if(!hold) release();}
      else throw new HttpError(400,'invalid_control','Invalid control');
      json(res,200,{mode,hold});return;
    }
    if(req.url?.startsWith('/teaching/')) throw new HttpError(404,'not_found','Not found');
    const match=/^\/products\/([A-Za-z0-9_-]{1,32})$/.exec(req.url ?? '');
    if(!match || req.method!=='GET') throw new HttpError(400,'invalid_request','Expected GET product');
    calls=Math.min(1000000,calls+1);
    if(hold) {
      if(held.size>=2) throw new HttpError(503,'held_full','Hold full');
      await new Promise<void>(resolve=>{
        const done=()=>{clearTimeout(timer);held.delete(done);res.off('close',done);resolve();};
        const timer=setTimeout(done,1500);held.add(done);res.once('close',done);
      });
    }
    if(res.destroyed) return;
    if(mode==='unavailable') {json(res,503,{error:'unavailable'});return;}
    json(res,200,{id:match[1],price:variant==='shadow' && mode==='different'?12000:10000,currency:'VND'});
  });
  process.once('SIGTERM',()=>{release();server.closeAllConnections();});
}
if(import.meta.main) await main();
