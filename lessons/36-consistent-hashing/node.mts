import { serve, json, methodNotAllowed } from '../../lib/http.mts';
import { Cache } from './cache.mts';
import { members } from './ring.mts';
import { pathKey } from './runtime.mts';
export async function main() {
  const id = members([process.env.CACHE_ID ?? process.env.NODE_ID])[0]!;
  const cache = new Cache();
  return serve(`cache-${id}`,4631,(req,res)=>{
    const key = pathKey(req.url,'/objects/');
    if(key!==undefined) {
      if(req.method!=='GET') methodNotAllowed(res,'GET');
      json(res,200,{key,owner:id,...cache.get(key)}); return;
    }
    json(res,404,{error:'not_found'});
  });
}
if(import.meta.main) await main();
