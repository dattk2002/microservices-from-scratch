import { listen, json, lifetime } from './runtime.mts';
import { Parser } from './stream.mts';
export async function main() {
  const upstream=new URL(process.env.PRODUCER_URL ?? 'http://127.0.0.1:9001');
  if(upstream.protocol!=='http:' || upstream.hostname!=='127.0.0.1') throw new Error('loopback producer required');
  const teaching=process.env.TEACHING_CONTROLS==='1'; const stats={active:0,completed:0,failed:0,rejected:0};
  return listen(async(req,res)=> {
    const url=new URL(req.url ?? '/', 'http://local');
    if(teaching && req.method==='GET' && url.pathname==='/control/stats') {json(res,200,stats);return;}
    if(req.method!=='GET' || url.pathname!=='/summary') {json(res,404,{error:'not_found'});return;}
    if(stats.active>=2) {stats.rejected++;json(res,503,{error:'saturated'});return;}
    const mode=url.searchParams.get('mode');
    if(mode && !teaching) {json(res,400,{error:'mode'});return;}
    stats.active++; const life=lifetime(res,3000);
    let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
    try {
      const target=new URL('/stream',upstream); if(mode) target.searchParams.set('mode',mode);
      const response=await fetch(target,{signal:life.signal});
      if(response.status!==200 || response.headers.get('content-type')?.split(';')[0]!=='application/x-ndjson' || !response.body) throw new Error('upstream');
      reader=response.body.getReader(); const parser=new Parser();
      while(true) {
        let timer:ReturnType<typeof setTimeout>|undefined;
        try {
          const result=await Promise.race([reader.read(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('read deadline')),700);})]);
          if(result.done) break; parser.feed(result.value);
        } finally {clearTimeout(timer);}
      }
      const summary=parser.finish(); stats.completed++; json(res,200,summary);
    } catch {stats.failed++;if(!res.destroyed) json(res,502,{error:'invalid_stream'});}
    finally {await reader?.cancel().catch(()=>{});life.clean();stats.active--;}
  });
}
if(import.meta.main) await main();
