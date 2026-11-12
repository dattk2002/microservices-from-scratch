import { serve, json, readJson } from '../../lib/http.mts';
import { exact, packet, replica, snapshot, requireBody, fail } from './protocol.mts';
import type { Replica, Snapshot } from './protocol.mts';
export function origin(raw:string|undefined):string {
 if(!raw) throw new Error('Origin required'); const u=new URL(raw);
 if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password||u.pathname!=='/'||u.search||u.hash) throw new Error('Expected loopback HTTP origin');
 return u.origin;
}
export async function upstream(url:string,signal:AbortSignal,limit:number,body?:unknown):Promise<unknown> {
 const response=await fetch(url,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)}),redirect:'error',signal});
 if(response.status!==200) { await response.body?.cancel(); throw new Error('Upstream status'); }
 if(!response.body) throw new Error('Missing body');
 const reader=response.body.getReader(); const chunks:Uint8Array[]=[]; let size=0;
 try { while(true) { const chunk=await reader.read(); if(chunk.done) break; size+=chunk.value.length; if(size>limit) throw new Error('Upstream bytes'); chunks.push(chunk.value); } }
 finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
 return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
export async function main() {
 const a=origin(process.env.A_ORIGIN),b=origin(process.env.B_ORIGIN); if(a===b) throw new Error('Origins must differ');
 const origins={a,b}; const busy=new Set<Replica>();
 await serve('snapshot-channel',3062,async(req,res)=>{
  if(req.method==='POST'&&req.url==='/pump') {
   const body=requireBody(await readJson(req),'from'); if(!replica(body.from)) fail(400,'invalid_from');
   const from=body.from; if(busy.has(from)) fail(409,'busy'); busy.add(from);
   const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),500);
   try {
    const head=await upstream(origins[from]+'/head',controller.signal,2048);
    if(!exact(head,['message'])||!(head.message===null||packet(head.message)&&head.message.from===from)) throw new Error('Invalid head');
    if(head.message===null) return json(res,200,{delivered:false});
    const p=head.message; const target=from==='a'?'b':'a';
    const delivered=await upstream(origins[target]+'/messages',controller.signal,256,p);
    if(!exact(delivered,['seq'])||delivered.seq!==p.seq) throw new Error('Invalid receipt');
    const ack=await upstream(origins[from]+'/ack',controller.signal,256,{seq:p.seq});
    if(!exact(ack,['seq'])||ack.seq!==p.seq) throw new Error('Invalid ack');
    json(res,200,{delivered:true,from,seq:p.seq});
   } catch { fail(502,'upstream_failure'); } finally { clearTimeout(timer); busy.delete(from); }
   return;
  }
  if(req.method==='GET'&&req.url==='/snapshot') {
   const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),500);
   try {
    // Sequential reads still share the same absolute budget. No partial result escapes.
    const av=await upstream(a+'/snapshot',controller.signal,16384);
    const bv=await upstream(b+'/snapshot',controller.signal,16384);
    const read=(v:unknown,id:Replica):Snapshot|null=>{ if(!exact(v,['snapshot'])||!(v.snapshot===null||snapshot(v.snapshot,id))) throw new Error('Invalid snapshot'); return v.snapshot; };
    const sa=read(av,'a'),sb=read(bv,'b');
    if(sa&&sb&&sa.snapshotId!==sb.snapshotId) return json(res,409,{error:{code:'snapshot_conflict',message:'snapshot_conflict'}});
    if(!sa||!sb||sa.channelOpen||sb.channelOpen) return json(res,200,{complete:false});
    const inFlight=[...sa.inFlight,...sb.inFlight].sort((x,y)=>x.from.localeCompare(y.from)||x.seq-y.seq);
    json(res,200,{complete:true,snapshotId:sa.snapshotId,balances:{a:sa.localBalance,b:sb.localBalance},inFlight,total:sa.localBalance+sb.localBalance+inFlight.reduce((n,p)=>n+p.amount,0)});
   } catch { fail(502,'upstream_failure'); } finally { clearTimeout(timer); }
   return;
  }
  fail(404,'not_found');
 });
}
if(import.meta.main) await main();
