import { serve,json } from '../../lib/http.mts';
import { Store,fail,record } from './store.mts';
import { body } from './wire.mts';
export async function main(){
 const store=new Store(process.env.STORE_DB??'uploads.sqlite');
 try{const server=await serve('upload',4343,async(req,res)=>{
 const path=new URL(req.url??'/', 'http://local').pathname;
 if(path==='/uploads'&&req.method==='POST'){json(res,200,store.create(await body(req)));return;}
 const match=/^\/(uploads|objects)\/([A-Za-z0-9_-]{1,32})(?:\/(complete|parts\/([1-8])))?$/.exec(path);
 if(!match)fail(404);const key=match[2]!;
 if(match[1]==='objects'&& !match[3]&&req.method==='GET'){const o=store.object(key);if(!o)fail(404);json(res,200,o);return;}
 if(match[1]==='uploads'){
 if(!match[3]&&req.method==='GET'){json(res,200,store.get(key));return;}
 if(!match[3]&&req.method==='DELETE'){json(res,200,store.abort(key));return;}
 if(match[3]==='complete'&&req.method==='POST'){const input=await body(req); record(input);json(res,200,store.complete(key));return;}
 if(match[4]&&req.method==='PUT'){json(res,200,store.put(key,Number(match[4]),await body(req)));return;}
 }fail(404);
 });server.once('close',()=>store.close());return server;}catch(e){store.close();throw e;}
}
if(import.meta.main)await main();
