import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, json, readJson, serve } from '../../lib/http.mts';
import { decimal, fail, invalid, parameters, privateDatabaseFile, validateHost } from './ranking.mts';
import { ShardStore } from './store.mts';

export function shardHandler(store:ShardStore) {
  return async(req:IncomingMessage,res:ServerResponse):Promise<void>=>{
    try {
      const u=new URL(req.url??'/','http://shard');
      if(u.pathname==='/publish') {
        if(req.method!=='POST') fail(405,'method_not_allowed');
        if(u.search!=='') invalid();
        json(res,200,store.publish(await readJson(req)));return;
      }
      const item=/^\/items\/([^/]+)$/.exec(u.pathname);
      if(item) {
        if(req.method!=='PUT') fail(405,'method_not_allowed');
        if(u.search!=='') invalid();
        json(res,200,store.write(item[1],await readJson(req)));return;
      }
      const snapshot=/^\/snapshots\/([^/]+)\/top$/.exec(u.pathname);
      if(snapshot) {
        if(req.method!=='GET') fail(405,'method_not_allowed');
        parameters(u.searchParams,['k']);
        const r=decimal(snapshot[1],0,16),k=decimal(u.searchParams.get('k')??undefined,1,8);
        json(res,200,store.top(r,k));return;
      }
      fail(404,'not_found');
    } catch(error) {
      if(error instanceof HttpError) fail(error.status,error.code);
      throw error;
    }
  };
}
export async function main():Promise<void> {
  validateHost(process.env.HOST);
  const shard=process.env.SHARD_ID,file=privateDatabaseFile(process.env.DB_PATH);
  if(shard!=='a'&&shard!=='b') throw new Error('SHARD_ID=a|b and private DB_PATH required');
  // Dynamic import here keeps importing either entrypoint silent on Node 24.12.
  const {DatabaseSync}=await import('node:sqlite');
  const db=new DatabaseSync(file);
  try {
    const store=new ShardStore(db,shard);
    const server=await serve(`top-k-shard-${shard}`,3075,shardHandler(store));
    server.once('close',()=>store.close());
  } catch(error) {db.close();throw error;}
}
if(import.meta.main) main().catch((error:unknown)=>{console.error(error instanceof Error?error.message:'Startup failed');process.exitCode=1;});
