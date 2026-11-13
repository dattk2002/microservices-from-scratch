import { serve, json, readJson } from '../../lib/http.mts';
import { CoordinatorStore } from './store.mts';
import { Coordinator } from './engine.mts';
import { fail, fields, origins, parseTxId, tuple } from './protocol.mts';

export async function main() {
 const targets=origins(process.env.A_ORIGIN,process.env.B_ORIGIN);
 const path=process.env.DB_PATH;if(!path||path===':memory:')throw new Error('Private durable DB_PATH required');
 const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(path);
 try {
  const store=new CoordinatorStore(db,targets);const coordinator=new Coordinator(store,targets);
  const server=await serve('2pc-coordinator',3067,async(req,res)=>{
   if(req.method==='POST'&&req.url==='/transactions'){
    const b=tuple(await readJson(req));const result=store.create(b.txId,b.amount);
    return json(res,result.created?201:200,result.record);
   }
   if(req.method==='GET'&&req.url?.startsWith('/transactions/')){
    let id:string;try{id=decodeURIComponent(req.url.slice('/transactions/'.length));}catch{fail(400,'invalid_body');}
    return json(res,200,store.get(parseTxId(id)));
   }
   if(req.method==='POST'&&(req.url==='/step'||req.url==='/deliver')){
    const b=fields(await readJson(req),['txId']);const id=parseTxId(b.txId);
    return json(res,200,await (req.url==='/step'?coordinator.step(id):coordinator.deliver(id)));
   }
   fail(404,'not_found');
  });
  server.once('close',()=>db.close());return server;
 }catch(error){db.close();throw error;}
}
if(import.meta.main)await main();
