import { DatabaseSync } from 'node:sqlite';
import { HttpError, json, readJson, serve } from '../../lib/http.mts';
import { actor, elementBody, Store } from './state.mts';
export async function main() {
  const id=process.env.REPLICA_ID;
  if (!actor(id)) throw new Error('REPLICA_ID must be a or b');
  const path=process.env.DB_PATH;
  if (!path) throw new Error('DB_PATH is required');
  const db=new DatabaseSync(path);
  try {
    const store=new Store(db,id);
    const server=await serve(`replica-${id}`,6262,async(req,res)=>{
      if(req.method==='GET' && req.url==='/state') {json(res,200,store.snapshot()); return;}
      if(req.method==='GET' && req.url==='/values') {json(res,200,{values:store.values()}); return;}
      if(req.method==='POST' && req.url==='/add') {json(res,200,store.add(elementBody(await readJson(req)))); return;}
      if(req.method==='POST' && req.url==='/remove') {json(res,200,store.remove(elementBody(await readJson(req)))); return;}
      if(req.method==='POST' && req.url==='/merge') {json(res,200,store.merge(await readJson(req))); return;}
      throw new HttpError(404,'not_found','Route not found');
    });
    server.once('close',()=>db.close());
    return server;
  } catch(error) { db.close(); throw error; }
}
if(import.meta.main) main().catch((error:unknown)=>{console.error(error instanceof Error?error.message:'Startup failed');process.exitCode=1;});
