import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { json, readJson } from '../../../lib/http.mts';
import { exact, messages } from '../contracts.mts';

// Two reachable distinct origins, one process. Counter is never reset by mode changes.
export async function main(): Promise<void> {
  let count=0;
  const target=createServer((req,res)=>{
    count++; req.resume(); json(res,200,{received:true});
  });
  const timers=new Set<ReturnType<typeof setTimeout>>();
  const later=(fn: ()=>void)=>{
    const timer=setTimeout(()=>{ timers.delete(timer); fn(); },700); timers.add(timer);
  };
  let mode='created';
  let source: Server | undefined;
  const close=()=>{
    for (const timer of timers) clearTimeout(timer);
    for (const server of [source,target]) { server?.close(); server?.closeAllConnections(); }
  };
  try {
    await new Promise<void>((resolve,reject)=>{ target.once('error',reject); target.listen(0,'127.0.0.1',resolve); });
    const address=target.address();
    if (!address || typeof address === 'string') throw new Error('No target port');
    const destination=`http://127.0.0.1:${address.port}`;
    source=createServer((req,res)=>{
      void (async ()=>{
        if (req.url === '/counter') { json(res,200,{count}); return; }
        const body=await readJson(req);
        if (req.url === '/control') {
          if (!exact(body,['mode']) || typeof body.mode !== 'string') { json(res,400,{}); return; }
          mode=body.mode; json(res,200,{mode}); return;
        }
        const id=exact(body,['id','side','key','time','value']) ? body.id : 'x';
        const code = mode === 'late' ? 'late_event' : mode === 'conflict' ? 'id_conflict' : mode === 'capacity' ? 'capacity' : 'watermark_regression';
        const status=code === 'capacity' ? 429 : 409;
        if (['late','conflict','capacity','regression'].includes(mode)) { json(res,status,{error:{code,message:messages[code]}}); return; }
        if (mode === 'redirect') { res.writeHead(307,{location:destination+'/captured'}); res.end(); return; }
        if (mode === 'disconnect') { req.socket.destroy(); return; }
        if (mode === 'headersdelay') { later(()=>json(res,201,{id,duplicate:false})); return; }
        if (mode === 'bodydelay') {
          res.writeHead(201,{'content-type':'application/json'}); res.write('{"id":');
          later(()=>res.end(JSON.stringify(id)+',"duplicate":false}')); return;
        }
        if (mode === 'unknown409' || mode === 'unknown429') { json(res,mode === 'unknown409'?409:429,{error:{code:'internal_error',message:'Unexpected service error'}}); return; }
        if (mode === 'wrongmessage') { json(res,409,{error:{code:'late_event',message:'wrong'}}); return; }
        if (mode === 'extraerror') { json(res,409,{error:{code:'late_event',message:messages.late_event,extra:1}}); return; }
        if (mode === 'primitive409') { json(res,409,1); return; }
        if (mode === 'array429') { json(res,429,[]); return; }
        if (mode === 'wrongfields409') { json(res,409,{code:'late_event',message:messages.late_event}); return; }
        if (mode === 'unexpected500') { json(res,500,{error:{code:'late_event',message:messages.late_event}}); return; }
        if (mode === 'null') { json(res,201,null); return; }
        if (mode === 'wrongid') { json(res,201,{id:'other',duplicate:false}); return; }
        if (mode === 'wrongduplicate') { json(res,201,{id,duplicate:true}); return; }
        if (mode === 'extra') { json(res,201,{id,duplicate:false,extra:1}); return; }
        if (mode === 'wrongmarks') { json(res,200,{watermarks:{left:105,right:13}}); return; }
        if (mode === 'type') { res.writeHead(201,{'content-type':'text/plain'}); res.end(JSON.stringify({id,duplicate:false})); return; }
        if (mode === 'malformed') { res.writeHead(201,{'content-type':'application/json'}); res.end('{'); return; }
        if (mode === 'oversize' || mode === 'oversize409') {
          const value=mode === 'oversize' ? {id,duplicate:false} : {error:{code:'late_event',message:messages.late_event}};
          // Escape string tokens including field names without touching true/false/null/numbers.
          const wire=JSON.stringify(value).replace(/"(?:[^"\\]|\\.)*"/g,token=>{
            const decoded: unknown=JSON.parse(token);
            if (typeof decoded !== 'string') throw new Error('Expected string token');
            return '"'+Array.from(decoded,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('')+'"';
          })+' '.repeat(8193);
          res.writeHead(mode === 'oversize'?201:409,{'content-type':'application/json'}); res.end(wire); return;
        }
        if (mode === 'watermark') { json(res,200,{watermarks:{left:-1,right:13}}); return; }
        json(res,mode === 'duplicate'?200:201,{id,duplicate:mode === 'duplicate'});
      })().catch(()=>{ if (!res.writableEnded && !res.destroyed) json(res,500,{error:'fixture_failure'}); });
    });
    const listener=source;
    await new Promise<void>((resolve,reject)=>{ listener.once('error',reject); listener.listen(0,'127.0.0.1',resolve); });
    const ready=source.address();
    if (!ready || typeof ready === 'string') throw new Error('No source port');
    process.once('SIGTERM',close); process.once('SIGINT',close);
    console.log(JSON.stringify({port:ready.port}));
  } catch (error) { close(); throw error; }
}
if (import.meta.main) await main();
