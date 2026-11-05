import { Owner } from './store.mts';
import { serve,json,readJson,HttpError,numberSetting } from '../../lib/http.mts';
export async function main(){
 const store=new Owner(process.env.DB_PATH??'owner.sqlite',Date.now,numberSetting('TTL_MS',60000,100,300000));
 try {const server=await serve('owner',3028,async(req,res)=>{
 const path=req.url;
 if(req.method!=='POST')throw new HttpError(405,'method','POST required');
 const body=await readJson(req); if(!body||typeof body!=='object'||Array.isArray(body))throw new HttpError(400,'body','object required');
 const b=body as Record<string,unknown>;
 if(path==='/resources'){store.put(b.id,b.kind,b.value);json(res,200,{ok:true});}
 else if(path==='/delete'){if(typeof b.id!=='number'||!Number.isSafeInteger(b.id)||b.id<1)throw new HttpError(400,'id','id required');store.db.prepare('DELETE FROM live WHERE id=?').run(b.id);json(res,200,{ok:true});}
 else if(path==='/snapshots')json(res,201,{token:store.create(b.kind,b.size)});
 else if(path==='/page')json(res,200,store.page(b.token,b.kind,b.size));
 else throw new HttpError(404,'route','unknown route');
 });server.once('close',()=>store.close());}catch(e){store.close();throw e;}
}
if(import.meta.main)await main();
