import { DatabaseSync } from 'node:sqlite';
import { HttpError, json, readJson, serve } from '../../lib/http.mts';
import { Replica, member, fail } from './core.mts';

export async function main() {
  const id=process.env.REPLICA_ID;
  if(!member(id)) throw new Error('REPLICA_ID must be a, b or c');
  const path=process.env.DB_PATH;
  if(!path) throw new Error('DB_PATH is required');
  const db=new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000');
    const replica=new Replica(db,id);
    const server=await serve(`causal-${id}`,3063,async(req,res)=>{
      const path=req.url;
      if(req.method==='POST' && path==='/publish') {json(res,201,replica.publish(await readJson(req)));return;}
      if(req.method==='POST' && path==='/receive') {
        const result=replica.receive(await readJson(req));json(res,result.status,result.body);return;
      }
      if(req.method==='GET' && path==='/state') {json(res,200,replica.state());return;}
      const tuple=path?.match(/^\/events\/([abc])\/([1-8])$/);
      if(req.method==='GET' && tuple) {
        const sender=tuple[1];
        if(!member(sender)) fail(400,'invalid_request');
        json(res,200,replica.get(sender,Number(tuple[2])));return;
      }
      throw new HttpError(404,'not_found','Unknown route');
    });
    server.once('close',()=>db.close());
    return server;
  } catch(error) {db.close();throw error;}
}
if(import.meta.main) await main();
