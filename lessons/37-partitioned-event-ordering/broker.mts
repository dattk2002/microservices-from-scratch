import { DatabaseSync } from 'node:sqlite';
import { HttpError,json,serve } from '../../lib/http.mts';
import { Broker } from './model.mts';
import { admitted,body,queryInteger } from './runtime.mts';

export async function main() {
  const db=new DatabaseSync(process.env.DB_PATH??'broker.sqlite');
  try {
    const broker=new Broker(db);
    const server=await serve('partition-broker',3037,admitted(async(req,res)=>{
      const url=new URL(req.url??'/', 'http://local');
      if(url.pathname==='/events' && req.method==='POST') {
        const result=broker.append(await body(req));
        json(res,200,result);return;
      }
      if(url.pathname==='/events' && req.method==='GET') {
        const partition=queryInteger(url.searchParams.get('partition'),0,2);
        const after=queryInteger(url.searchParams.get('after'),0,32);
        const limit=queryInteger(url.searchParams.get('limit'),1,8);
        json(res,200,{partition,after,events:broker.read(partition,after,limit)});return;
      }
      throw new HttpError(404,'not_found','unknown route');
    }));
    server.once('close',()=>db.close());
    return server;
  } catch(error) {db.close();throw error;}
}
if(import.meta.main) await main();
