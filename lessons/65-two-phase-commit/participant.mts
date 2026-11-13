import { serve, json, readJson } from '../../lib/http.mts';
import { Participant } from './store.mts';
import { fail, fields, tuple, parseAmount, parseDecision, parseTxId } from './protocol.mts';

export async function main() {
 const id=process.env.PARTICIPANT_ID;
 if(id!=='a'&&id!=='b')throw new Error('PARTICIPANT_ID must be a or b');
 const path=process.env.DB_PATH;if(!path||path===':memory:')throw new Error('Private durable DB_PATH required');
 const {DatabaseSync}=await import('node:sqlite');
 const db=new DatabaseSync(path);
 try {
  const participant=new Participant(db,id);
  const server=await serve(`2pc-${id}`,id==='a'?3065:3066,async(req,res)=>{
   if(req.method==='GET'&&req.url==='/state')return json(res,200,participant.state());
   if(req.method==='POST'&&req.url==='/prepare'){
    const b=tuple(await readJson(req));return json(res,200,participant.prepare(b.txId,b.amount));
   }
   if(req.method==='POST'&&req.url==='/decide'){
    const b=fields(await readJson(req),['txId','amount','decision']);
    return json(res,200,participant.decide(parseTxId(b.txId),parseAmount(b.amount),parseDecision(b.decision)));
   }
   fail(404,'not_found');
  });
  server.once('close',()=>db.close());return server;
 }catch(error){db.close();throw error;}
}
if(import.meta.main)await main();
