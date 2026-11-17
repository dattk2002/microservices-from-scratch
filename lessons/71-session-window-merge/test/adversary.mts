import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { json, readJson } from '../../../lib/http.mts';
import { exact } from '../contracts.mts';

export function oversizeWire(value: unknown): string {
  const encoded=JSON.stringify(value);
  if (encoded === undefined) throw new Error('Fixture must be JSON');
  // Decode and escape string tokens only: false, true, null and numbers must stay JSON literals.
  return encoded.replace(/"(?:[^"\\]|\\.)*"/g,token=>{
    const decoded: unknown=JSON.parse(token);
    if (typeof decoded !== 'string') throw new Error('Expected string token');
    return '"'+Array.from(decoded,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('')+'"';
  })+' '.repeat(8193);
}
const modes=['created','duplicate','conflict','late','capacity','watermark','regression','redirect','disconnect',
  'headersdelay','bodydelay','combineddelay','unknown409','unknown429','primitive409','array429','wrongfields409',
  'extraerror','wrongmessage','unexpected500','null','wrongid','wrongduplicate','extra','wrongmark','type','malformed',
  'oversize','oversize409'];

export async function main(): Promise<void> {
  let count=0, mode='created';
  let source: Server | undefined; let target: Server | undefined;
  const timers=new Set<ReturnType<typeof setTimeout>>();
  const later=(delay: number, action: ()=>void)=>{
    const timer=setTimeout(()=>{ timers.delete(timer); action(); },delay); timers.add(timer);
  };
  const close=()=>{
    for (const timer of timers) clearTimeout(timer);
    for (const server of [source,target]) { server?.close(); server?.closeAllConnections(); }
  };
  try {
    target=createServer((req,res)=>{ count++; req.resume(); json(res,200,{received:true}); });
    const destinationServer=target;
    await new Promise<void>((resolve,reject)=>{ destinationServer.once('error',reject); destinationServer.listen(0,'127.0.0.1',resolve); });
    const address=target.address();
    if (!address || typeof address === 'string') throw new Error('No target port');
    const destination=`http://127.0.0.1:${address.port}`;
    source=createServer((req,res)=>{
      void (async ()=>{
        if (req.url === '/counter') { json(res,200,{count}); return; }
        const body=await readJson(req);
        if (req.url === '/control') {
          if (!exact(body,['mode']) || typeof body.mode !== 'string' || !modes.includes(body.mode)) {
            json(res,400,{error:{code:'invalid_request',message:'invalid_request'}}); return;
          }
          mode=body.mode; json(res,200,{mode}); return;
        }
        const id=exact(body,['id','key','time','value']) && typeof body.id === 'string' ? body.id : 'x';
        const code=mode === 'conflict' ? 'id_conflict' : mode === 'late' ? 'late_event' : mode === 'capacity' ? 'capacity' : 'watermark_regression';
        if (['conflict','late','capacity','regression'].includes(mode)) {
          json(res,code === 'capacity'?429:409,{error:{code,message:code}}); return;
        }
        if (mode === 'redirect') { res.writeHead(307,{location:destination+'/capture'}); res.end(); return; }
        if (mode === 'disconnect') { req.socket.destroy(); return; }
        if (mode === 'headersdelay') { later(700,()=>json(res,201,{id,duplicate:false})); return; }
        if (mode === 'bodydelay') {
          res.writeHead(201,{'content-type':'application/json'}); res.write('{"id":');
          later(700,()=>res.end(JSON.stringify(id)+',"duplicate":false}')); return;
        }
        if (mode === 'combineddelay') {
          later(300,()=>{
            if (res.destroyed) return;
            res.writeHead(201,{'content-type':'application/json'}); res.write('{"id":');
            later(300,()=>res.end(JSON.stringify(id)+',"duplicate":false}'));
          }); return;
        }
        if (mode === 'unknown409' || mode === 'unknown429') {
          json(res,mode === 'unknown409'?409:429,{error:{code:'internal_error',message:'internal_error'}}); return;
        }
        if (mode === 'primitive409') { json(res,409,1); return; }
        if (mode === 'array429') { json(res,429,[]); return; }
        if (mode === 'wrongfields409') { json(res,409,{code:'late_event',message:'late_event'}); return; }
        if (mode === 'extraerror') { json(res,409,{error:{code:'late_event',message:'late_event',extra:1}}); return; }
        if (mode === 'wrongmessage') { json(res,409,{error:{code:'late_event',message:'wrong'}}); return; }
        if (mode === 'unexpected500') { json(res,500,{error:{code:'late_event',message:'late_event'}}); return; }
        if (mode === 'null') { json(res,201,null); return; }
        if (mode === 'wrongid') { json(res,201,{id:'other',duplicate:false}); return; }
        if (mode === 'wrongduplicate') { json(res,201,{id,duplicate:true}); return; }
        if (mode === 'extra') { json(res,201,{id,duplicate:false,extra:1}); return; }
        if (mode === 'wrongmark') { json(res,200,{watermark:12}); return; }
        if (mode === 'type') { res.writeHead(201,{'content-type':'text/plain'}); res.end(JSON.stringify({id,duplicate:false})); return; }
        if (mode === 'malformed') { res.writeHead(201,{'content-type':'application/json'}); res.end('{'); return; }
        if (mode === 'oversize' || mode === 'oversize409') {
          const value=mode === 'oversize' ? {id,duplicate:false} : {error:{code:'late_event',message:'late_event'}};
          res.writeHead(mode === 'oversize'?201:409,{'content-type':'application/json'}); res.end(oversizeWire(value)); return;
        }
        if (mode === 'watermark') { json(res,200,{watermark:13}); return; }
        json(res,mode === 'duplicate'?200:201,{id,duplicate:mode === 'duplicate'});
      })().catch(()=>{ if (!res.destroyed && !res.writableEnded) json(res,500,{error:{code:'fixture_failure',message:'fixture_failure'}}); });
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
