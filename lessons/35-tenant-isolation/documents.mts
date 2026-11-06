import { createPublicKey } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { HttpError } from '../../lib/http.mts';
import { verifyContext,Store,parseWrite } from './model.mts';
import { serve,json,readJson,route } from './runtime.mts';
export async function main() {
 const key=createPublicKey(process.env.PUBLIC_KEY_PEM??'');
 if(key.asymmetricKeyType!=='ed25519') throw Error('Ed25519 required');
 const db=new DatabaseSync(process.env.DB_PATH??'documents.sqlite'); const store=new Store(db);
 try {
 const server=await serve('tenant-documents',3531,async(req,res)=>{
  const claims=verifyContext(req.headers['x-tenant-context'],key);
  const {id}=route(req);
  if(req.method==='GET') {
   if(!id) {json(res,200,{documents:store.list(claims.tenant)});return;}
   const found=store.get(claims.tenant,id);
   if(!found) throw new HttpError(404,'not_found','Not found');
   json(res,200,found);return;
  }
  if(req.method==='POST'&&id) {
   const write=parseWrite(await readJson(req));
   json(res,200,store.put(claims.tenant,id,write.op,write.text));return;
  }
  throw new HttpError(405,'method_not_allowed','Use GET or POST document');
 });
 server.once('close',()=>db.close()); return server;
 } catch(error) {db.close();throw error;}
}
if(import.meta.main) await main();
