import { DatabaseSync } from 'node:sqlite';
import { serve, json } from '../../lib/http.mts';
import { fields, fail } from './protocol.mts';
import { readBody, settings } from './runtime.mts';
import { SourceStore } from './store.mts';

export async function main() {
 const config=settings('source');const db=new DatabaseSync(config.path);
 try {
  const store=new SourceStore(db);
  const server=await serve('cdc-source',3069,async(req,res)=>{
   if(req.method==='GET'&&req.url==='/snapshot')return json(res,200,store.snapshot());
   if(req.method==='GET'&&(req.url==='/changes'||req.url?.startsWith('/changes?'))) {
    const url=new URL(req.url,'http://127.0.0.1');const entries=[...url.searchParams];const raw=url.searchParams.get('after');
    if(entries.length!==1||entries[0]?.[0]!=='after'||raw===null||! /^(0|[1-9][0-9]?)$/.test(raw))fail(400,'invalid_body');
    return json(res,200,store.changes(Number(raw)));
   }
   if(req.url?.startsWith('/items/')&&(req.method==='PUT'||req.method==='DELETE')) {
    let k:string;try{k=decodeURIComponent(req.url.slice(7));}catch{fail(400,'invalid_body');}
    if(req.method==='DELETE') {
     if(req.headers['transfer-encoding']||Number(req.headers['content-length']??0)!==0)fail(400,'invalid_body');
     return json(res,200,store.remove(k));
    }
    const body=fields(await readBody(req),['value']);return json(res,200,store.put(k,body.value));
   }
   fail(404,'not_found');
  });
  server.once('close',()=>db.close());return server;
 }catch(error){db.close();throw error;}
}
if(import.meta.main)await main();
