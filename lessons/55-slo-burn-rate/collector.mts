import { HttpError,json,readJson,serve } from '../../lib/http.mts';
import { Store,parseBucket } from './model.mts';
export async function main() {
  const store=new Store(process.env.DB_PATH??'buckets.sqlite');
  try {
    const server=await serve('slo-collector',5551,async(req,res)=>{
      if(req.url==='/buckets'&&req.method==='GET') {json(res,200,{buckets:store.all()});return;}
      if(req.url==='/buckets'&&req.method==='POST') {
        const value=await readJson(req);
        let bucket;
        try {bucket=parseBucket(value);} catch {throw new HttpError(400,'invalid_bucket','Expected {slot,total,bad}');}
        const status=store.put(bucket);
        json(res,status,status===409?{error:'immutable_slot'}:bucket);return;
      }
      json(res,404,{error:'not_found'});
    });
    server.once('close',()=>store.db.close());
  } catch(error) {store.db.close();throw error;}
}
if(import.meta.main) await main();
