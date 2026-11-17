import { serve, json } from '../../lib/http.mts';
import { fail, fields } from './protocol.mts';
import { readBody, settings } from './runtime.mts';
import { ReplicaStore } from './store.mts';
import { Replica } from './engine.mts';

export async function main() {
 const config=settings('replica');if(!config.origin)throw new Error('SOURCE_ORIGIN required');
 const {DatabaseSync}=await import('node:sqlite');
 const db=new DatabaseSync(config.path);
 try {
  const store=new ReplicaStore(db,config.origin);const replica=new Replica(store);let busy=false;
  const server=await serve('cdc-replica',3070,async(req,res)=>{
   if(req.method==='GET'&&req.url==='/state')return json(res,200,store.state());
   if(req.method==='POST'&&(req.url==='/bootstrap'||req.url==='/pump')) {
    if(busy)fail(503,'busy');busy=true;
    const deadline=performance.now()+500;
    try {
     fields(await readBody(req,deadline),[]);
     return json(res,200,await (req.url==='/bootstrap'?replica.bootstrap(deadline):replica.pump(deadline)));
    } finally {busy=false;}
   }
   fail(404,'not_found');
  });
  server.once('close',()=>db.close());return server;
 }catch(error){db.close();throw error;}
}
if(import.meta.main)await main();
