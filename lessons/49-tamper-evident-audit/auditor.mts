import {DatabaseSync} from 'node:sqlite';
import {serve,json,readJson,numberSetting} from '../../lib/http.mts';
import {Anchor,fail,object,keys,validate} from './model.mts';
// Maximum canonical export < 4,700 bytes. 8,192 also accepts all legal fields
// encoded with six-byte JSON escapes (< 32,000); use 32,768 for that representation.
export const EXPORT_BYTES=32768;
export async function fetchChain(origin:string,deadline:number){
 const signal=AbortSignal.timeout(deadline);
 try{
 const r=await fetch(origin+'/export',{redirect:'error',signal});if(r.status!==200||!r.body)fail(502,'source_status');
 const reader=r.body.getReader();const chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>EXPORT_BYTES)fail(502,'export_too_large');chunks.push(value);}}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 return validate(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))) as unknown);
 }catch{fail(502,'source_invalid_or_unavailable');}
}
export async function main(){
 const origin=new URL(process.env.LOGGER_ORIGIN??'http://127.0.0.1:4941');
 if(origin.protocol!=='http:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw new Error('LOGGER_ORIGIN must be an HTTP origin');
 const deadline=numberSetting('VERIFY_TIMEOUT_MS',800,50,3000);
 const db=new DatabaseSync(process.env.DB_PATH??'auditor.sqlite');const anchor=new Anchor(db);
 try{const server=await serve('audit-auditor',4942,async(req,res)=>{
 if(req.method==='GET'&&req.url==='/state'){json(res,200,{checkpoint:anchor.state()});return;}
 if(req.method==='POST'&&(req.url==='/verify'||req.url==='/checkpoint')){
 const o=object(await readJson(req));keys(o,[]);
 const chain=await fetchChain(origin.origin,deadline);
 // Re-read checkpoint inside the synchronous transaction AFTER fetch, so concurrent
 // requests cannot overwrite a newer checkpoint with an older fetched snapshot.
 json(res,200,anchor.accept(chain,req.url==='/checkpoint'));return;
 }fail(404,'not_found');
 });server.once('close',()=>db.close());return server;}catch(e){db.close();throw e;}
}
if(import.meta.main)await main();
