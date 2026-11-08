import { serve, json, readJson, HttpError, methodNotAllowed, numberSetting } from '../../lib/http.mts';
import { members, owner } from './ring.mts';
import type { Member } from './ring.mts';
import { origin, pathKey, upstream } from './runtime.mts';
export async function main() {
  const origins = {a:origin('CACHE_A_ORIGIN','NODE_A_ORIGIN'),b:origin('CACHE_B_ORIGIN','NODE_B_ORIGIN'),c:origin('CACHE_C_ORIGIN','NODE_C_ORIGIN')};
  const timeout = numberSetting('UPSTREAM_TIMEOUT_MS',500,50,2000);
  const controls = process.env.TEACHING_CONTROLS==='1';
  let current: Member[] = ['a','b']; let epoch = 1;
  return serve('consistent-router',4630,async (req,res)=>{
    if(req.url==='/ring' && controls) {
      if(req.method!=='POST') methodNotAllowed(res,'POST');
      const body = await readJson(req);
      let next: Member[];
      try {
        if(typeof body!=='object' || body===null || Array.isArray(body) || !('members' in body) || Object.keys(body).length!==1) throw new Error('Invalid body');
        next = members(body.members);
      } catch {throw new HttpError(400,'invalid_members','Use a unique nonempty subset of a,b,c');}
      if(next.join(',')!==current.join(',')) {
        if(epoch===1_000_000) throw new HttpError(409,'epoch_exhausted','Restart demo router');
        current=next; epoch++;
      }
      json(res,200,{members:current,epoch}); return;
    }
    const placement = pathKey(req.url,'/placement/');
    const key = placement ?? pathKey(req.url,'/objects/');
    if(key!==undefined) {
      if(req.method!=='GET') methodNotAllowed(res,'GET');
      // Snapshot prevents a concurrent control request from relabeling an older reply.
      const selected = owner(key,current); const selectedEpoch = epoch;
      if(placement!==undefined) {json(res,200,{key,owner:selected,epoch:selectedEpoch}); return;}
      try {json(res,200,{...await upstream(origins[selected],key,selected,timeout),epoch:selectedEpoch});}
      catch {throw new HttpError(502,'owner_unavailable','Owner failed deadline or bounded reply contract');}
      return;
    }
    json(res,404,{error:'not_found'});
  });
}
if(import.meta.main) await main();
