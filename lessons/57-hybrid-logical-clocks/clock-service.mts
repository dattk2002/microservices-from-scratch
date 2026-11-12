import { serve,json,readJson } from '../../lib/http.mts';
import { Store,fail,object,integer } from './model.mts';
export async function main() {
  const replica=process.env.REPLICA_ID;
  if(replica!=='a'&&replica!=='b') throw new Error('REPLICA_ID must be a or b');
  if(!process.env.DB_PATH) throw new Error('DB_PATH required');
  const store=new Store(process.env.DB_PATH,replica);
  let offset=0;
  const teaching=process.env.TEACHING_CONTROLS==='1';
  try {
    const server=await serve('hlc',3057,async(req,res)=>{
      const path=req.url;
      if(req.method==='POST'&&path==='/teaching/clock'&&teaching) {
        const v=await readJson(req); if(!object(v,['offset'])||!integer(v.offset,-2000,10000)) fail(400);
        offset=v.offset; return json(res,200,{offset});
      }
      if(req.method==='GET'&&path==='/state') return json(res,200,store.state());
      if(req.method==='GET'&&path?.startsWith('/events/')) {
        const e=store.state().created.find(e=>e.id===path.slice(8)); if(!e) fail(404); return json(res,200,e);
      }
      if(req.method==='POST'&&(path==='/events'||path==='/receive')) {
        const v=await readJson(req); const now=teaching?1700000000000+offset:Date.now();
        const result=path==='/events'?store.create(v,now):store.receive(v,now);
        return json(res,result.status,result.body);
      }
      fail(404);
    });
    server.once('close',()=>store.db.close());
    return server;
  } catch(e) {store.db.close();throw e;}
}
if(import.meta.main) await main();
