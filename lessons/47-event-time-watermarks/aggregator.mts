import { DatabaseSync } from 'node:sqlite';
import { HttpError, json, readJson, serve } from '../../lib/http.mts';
import { Store } from './store.mts';
export async function main() {
  const path=process.env.DB_PATH;
  if(!path) throw new Error('DB_PATH required');
  const db=new DatabaseSync(path), store=new Store(db);
  try {
    const server=await serve('event-aggregator',4740,async(req,res)=> {
      if(req.method==='GET' && req.url==='/state') {json(res,200,store.state());return;}
      if(req.method==='POST' && req.url==='/events') {json(res,200,store.event(await readJson(req)));return;}
      if(req.method==='POST' && req.url==='/watermarks') {json(res,200,store.watermark(await readJson(req)));return;}
      throw new HttpError(404,'not_found','Unknown route');
    });
    server.once('close',()=>db.close());
  } catch(error) {db.close();throw error;}
}
if(import.meta.main) await main();
