import { serve, json, readJson } from '../../lib/http.mts';
import { Store } from './store.mts';
import { replica, integer, snapshotId, packet, requireBody, fail } from './protocol.mts';
export async function main() {
 const id=process.env.REPLICA_ID; if(!replica(id)) throw new Error('REPLICA_ID must be a or b');
 const path=process.env.DB_PATH; if(!path) throw new Error('DB_PATH required');
 const store=new Store(path,id);
 try {
  const server=await serve('snapshot-node',3060,async(req,res)=>{
   if(req.method==='GET') {
    if(req.url==='/state') return json(res,200,store.state());
    if(req.url==='/head') return json(res,200,{message:store.head()});
    if(req.url==='/snapshot') return json(res,200,{snapshot:store.snapshot()});
   }
   if(req.method==='POST'&&['/transfer','/ack','/snapshot','/messages'].includes(req.url??'')) {
    const body=await readJson(req);
    if(req.url==='/messages') { if(!packet(body)) fail(400,'invalid_packet'); store.receive(body); return json(res,200,{seq:body.seq}); }
    if(req.url==='/transfer') { const b=requireBody(body,'amount'); if(!integer(b.amount,1,5)) fail(400,'invalid_amount'); return json(res,201,store.transfer(b.amount)); }
    if(req.url==='/ack') { const b=requireBody(body,'seq'); if(!integer(b.seq,1,16)) fail(400,'invalid_seq'); store.ack(b.seq); return json(res,200,{seq:b.seq}); }
    const b=requireBody(body,'snapshotId'); if(!snapshotId(b.snapshotId)) fail(400,'invalid_snapshot_id'); const result=store.begin(b.snapshotId); return json(res,result.created?201:200,{snapshot:result.snapshot});
   }
   fail(404,'not_found');
  });
  server.once('close',()=>store.close());
 } catch(e) { store.close(); throw e; }
}
if(import.meta.main) await main();
