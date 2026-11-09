import { json, readJson, serve } from '../../lib/http.mts';
import { actor } from './model.mts';
import { Store } from './store.mts';
export async function main() {
  const identity=actor(process.env.ACTOR_ID);
  if(!process.env.DB_PATH) throw new Error('DB_PATH required');
  const store=new Store(process.env.DB_PATH,identity);
  try {
    const server=await serve('pn-replica',4141,async(req,res)=>{
      if(req.method==='GET' && req.url==='/state') return json(res,200,store.envelope());
      if(req.method==='POST' && req.url==='/changes') return json(res,200,store.apply(await readJson(req)));
      if(req.method==='POST' && req.url==='/merge') return json(res,200,store.receive(await readJson(req)));
      json(res,404,{error:'not_found'});
    });
    server.once('close',()=>store.close());
  } catch(e) { store.close(); throw e; }
}
if(import.meta.main) await main();
