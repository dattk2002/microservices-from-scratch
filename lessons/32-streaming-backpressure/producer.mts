import { listen, json, lifetime, barrier } from './runtime.mts';
import { encode, pump } from './stream.mts';
export async function main() {
  const teaching=process.env.TEACHING_CONTROLS==='1';
  let hold=false;
  const waiters=new Set<()=>void>();
  const stats={active:0,generated:0,blocked:0,drains:0,completed:0,cancelled:0,rejected:0};
  return listen(async(req,res)=>{
    const url=new URL(req.url ?? '/', 'http://local');
    if(teaching && req.method==='GET' && url.pathname==='/control/stats') {json(res,200,{...stats,waiting:waiters.size});return;}
    if(teaching && req.method==='POST' && ['/control/hold','/control/release'].includes(url.pathname)) {
      hold=url.pathname.endsWith('hold'); if(!hold) for(const release of [...waiters]) release();
      json(res,200,{hold});return;
    }
    if(req.method!=='GET' || url.pathname!=='/stream') {json(res,404,{error:'not_found'});return;}
    const mode=url.searchParams.get('mode') ?? 'normal';
    if(!['normal',...(teaching?['truncated','malformed','terminal','line','stream']:[])].includes(mode)) {json(res,400,{error:'mode'});return;}
    if(stats.active>=2) {stats.rejected++;json(res,503,{error:'saturated'});return;}
    stats.active++; const life=lifetime(res,4000);
    res.setHeader('content-type','application/x-ndjson; charset=utf-8');
    res.flushHeaders();
    async function* records() {
      for(let seq=0;seq<64;seq++) {
        if(hold) await barrier(life.signal, release=>{waiters.add(release);return ()=>{waiters.delete(release);};});
        life.signal.throwIfAborted(); stats.generated++;
        let chunk=encode({type:'item',seq,text:'\u0000'.repeat(320)});
        if((mode==='line' && seq===0) || mode==='stream') {
          const size=mode==='line'?2049:2048;
          chunk=Buffer.concat([chunk.subarray(0,-1),Buffer.alloc(size-chunk.length,32),Buffer.from('\n')]);
        }
        yield mode==='malformed' && seq===0 ? Buffer.from('{bad}\n') : chunk;
      }
      if(mode!=='truncated') yield encode({type:'end',count:mode==='terminal'?63:64});
    }
    try {await pump(res,records(),life.signal,stats);stats.completed++;res.end();}
    catch {stats.cancelled++;res.destroy();}
    finally {life.clean();stats.active--;}
  });
}
if(import.meta.main) await main();
