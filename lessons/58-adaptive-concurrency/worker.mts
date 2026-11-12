import { serve, json, readJson, HttpError } from '../../lib/http.mts';
import { object,idBody,lookup } from './contracts.mts';
export async function main() {
  const teaching=process.env.TEACHING_CONTROLS==='1';
  let hold=false,mode='normal',calls=0,active=0,maxConcurrent=0;
  const held=new Set<()=>void>();
  const server=await serve('worker',3058,async(req,res)=>{
    if(teaching&&req.url==='/teaching/state'&&req.method==='GET'){json(res,200,{calls,active,maxConcurrent});return;}
    if(teaching&&req.method==='POST'&&(req.url==='/teaching/hold'||req.url==='/teaching/behavior')){
      const isHold=req.url==='/teaching/hold';const body=object(await readJson(req),[isHold?'enabled':'mode']);
      if(isHold){if(typeof body.enabled!=='boolean')throw new HttpError(400,'invalid_body','Invalid body');hold=body.enabled;if(!hold)for(const release of held)release();}
      else {if(body.mode!=='normal'&&body.mode!=='unavailable')throw new HttpError(400,'invalid_body','Invalid body');mode=body.mode;}
      json(res,200,{ok:true});return;
    }
    if(req.url!=='/lookup'||req.method!=='POST')throw new HttpError(404,'not_found','Unknown route');
    const id=idBody(await readJson(req));calls=Math.min(65535,calls+1);active++;maxConcurrent=Math.min(65535,Math.max(maxConcurrent,active));
    try {
      if(hold){
        if(held.size>=4){json(res,503,{error:{code:'unavailable',message:'Worker unavailable'}});return;}
        await new Promise<void>(resolve=>{
          const release=()=>{clearTimeout(timer);held.delete(release);res.off('close',release);resolve();};
          const timer=setTimeout(release,800);held.add(release);res.once('close',release);
        });
      }
      if(res.destroyed)return;
      if(mode==='unavailable'){json(res,503,{error:{code:'unavailable',message:'Worker unavailable'}});return;}
      const value=lookup(id);
      if(value===undefined)json(res,404,{error:{code:'not_found',message:'Unknown id'}});else json(res,200,{id,value});
    }finally{active--;}
  });
  server.once('close',()=>{for(const release of held)release();});
  return server;
}
if(import.meta.main)await main();
