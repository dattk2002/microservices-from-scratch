import { json, readJson, serve } from '../../lib/http.mts';
import { Batcher, failure, idsFrom, validate } from './batcher.mts';
// Four maximally escaped IDs and all response field names fit comfortably in 2048 bytes.
export async function main(){
 const origin=new URL(process.env.CATALOG_ORIGIN??'http://127.0.0.1:5401');
 if(origin.protocol!=='http:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw Error('Invalid CATALOG_ORIGIN');
 const batcher=new Batcher(async(ids,signal)=>{
  const response=await fetch(new URL('/batch',origin),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ids}),redirect:'error',signal});
  if(response.status!==200){await response.body?.cancel();throw failure(502);}
  const reader=response.body?.getReader();if(!reader)throw failure(502);
  const chunks:Uint8Array[]=[];let bytes=0;
  try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>2048)throw failure(502);chunks.push(part.value);}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  return validate(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,ids);
 });
 const server=await serve('batch-gateway',5400,async(req,res)=>{
  if(req.method==='GET'&&req.url==='/state'){json(res,200,batcher.state());return;}
  if(req.method!=='POST'||req.url!=='/lookup'){json(res,404,{});return;}
  const controller=new AbortController();const deadline=setTimeout(()=>{
   controller.abort(failure(504));
   if(!res.destroyed&&!res.writableEnded){res.setHeader('connection','close');json(res,504,{error:{code:'lookup_failed'}});}
  },600);
  const disconnected=()=>{if(!res.writableEnded)controller.abort();};res.once('close',disconnected);
  try{const ids=idsFrom(await readJson(req),8);const items=await batcher.lookup(ids,controller.signal);if(!res.destroyed&&!res.writableEnded)json(res,200,{items});}
  catch(error){if(controller.signal.aborted&&!res.destroyed)throw failure(504);throw error;}
  finally{clearTimeout(deadline);res.off('close',disconnected);}
 });
 server.once('close',()=>batcher.close());
 process.once('SIGTERM',()=>batcher.close());process.once('SIGINT',()=>batcher.close());
 return server;
}
if(import.meta.main)await main();
