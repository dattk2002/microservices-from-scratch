import { json, readJson, serve } from '../../lib/http.mts';
import { replica } from './model.mts';
import { Store } from './store.mts';

export async function main() {
  const identity=replica(process.env.REPLICA_ID);
  const path=process.env.DB_PATH;
  if(!path) throw new Error('DB_PATH required');
  const store=new Store(path,identity);
  try {
    const server=await serve('escrow-replica',4161,async(req,res)=>{
      if(req.method==='GET' && req.url==='/state') return json(res,200,store.envelope());
      if(req.method==='POST' && req.url==='/spend') return json(res,200,store.spend(await readJson(req)));
      if(req.method==='POST' && req.url==='/transfer') return json(res,200,store.transfer(await readJson(req)));
      if(req.method==='POST' && req.url==='/merge') return json(res,200,store.receive(await readJson(req)));
      json(res,404,{error:{code:'not_found',message:'Route not found'}});
    });
    server.once('close',()=>store.close());
    return server;
  } catch(error) { store.close(); throw error; }
}
if(import.meta.main) await main();
