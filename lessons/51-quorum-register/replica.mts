import { json, readJson, serve } from '../../lib/http.mts';
import { fail, object, open, parseRegister, ReplicaStore } from './core.mts';
export async function main() {
  const path=process.env.DB_PATH;
  if (!path) throw new Error('DB_PATH required');
  const db=open(path), store=new ReplicaStore(db);
  let available=true;
  const controls=process.env.TEACHING_CONTROLS==='1';
  const server=await serve('replica',5151,async(req,res)=>{
    if (req.url==='/teaching/availability' && controls && req.method==='POST') {
      const body=await readJson(req);
      if (!object(body) || Object.keys(body).length!==1 || typeof body.available!=='boolean') fail(400,'invalid_availability');
      available=body.available; json(res,200,{available}); return;
    }
    if (req.url!=='/register') fail(404,'not_found');
    if (!available) fail(503,'unavailable');
    if (req.method==='GET') { json(res,200,store.get()); return; }
    if (req.method==='PUT') {
      const r=parseRegister(await readJson(req));
      if (!r) fail(400,'invalid_register');
      const status=store.put(r); json(res,status,store.get()); return;
    }
    fail(405,'method');
  });
  server.once('close',()=>db.close());
  return server;
}
if (import.meta.main) await main();
