import { serve,json,readJson,HttpError } from '../../lib/http.mts';
import { Store,actor } from './model.mts';
export async function main(){
 const id=actor(process.env.REPLICA_ID),path=process.env.DB_PATH;
 if(!path)throw new Error('DB_PATH required');
 const store=new Store(path,id);
 try {
 const server=await serve('register-'+id,5656,async(req,res)=>{
 if(req.method==='GET'&&req.url==='/value')return json(res,200,store.read());
 if(req.method==='POST'&&(req.url==='/write'||req.url==='/merge')){const body=await readJson(req);return json(res,200,req.url==='/write'?store.write(body):store.merge(body));}
 throw new HttpError(404,'not_found','Unknown route');
 });
 server.once('close',()=>store.close());return server;
 }catch(e){store.close();throw e;}
}
if(import.meta.main)await main();
