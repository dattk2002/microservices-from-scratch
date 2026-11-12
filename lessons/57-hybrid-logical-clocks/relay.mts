import { serve,json,readJson } from '../../lib/http.mts';
import { object,token,event,clock,fail } from './model.mts';
export function origin(raw:string|undefined):string {
  if(!raw) throw new Error('Origin required'); const u=new URL(raw);
  if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password||u.pathname!=='/'||u.search||u.hash) throw new Error('Expected loopback HTTP origin');
  return u.origin;
}
export async function bounded(response:Response):Promise<unknown> {
  if(!response.body) throw new Error('Missing body');
  const reader=response.body.getReader(); const chunks:Uint8Array[]=[];let bytes=0;
  try {while(true) {const r=await reader.read();if(r.done) break;bytes+=r.value.length;if(bytes>4096) throw new Error('Body too large');chunks.push(r.value);} return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;}
  finally {await reader.cancel();}
}
export async function main() {
  const a=origin(process.env.A_ORIGIN),b=origin(process.env.B_ORIGIN); if(a===b) throw new Error('Origins must differ');
  return serve('hlc-relay',3058,async(req,res)=>{
    if(req.method!=='POST'||req.url!=='/deliver') fail(404);
    const v=await readJson(req);if(!object(v,['from','id'])||(v.from!=='a'&&v.from!=='b')||!token(v.id,16)) fail(400);
    const source=v.from==='a'?a:b,target=v.from==='a'?b:a;
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),300);
    try {
      const r=await fetch(`${source}/events/${v.id}`,{redirect:'error',signal:controller.signal});
      const e=await bounded(r);
      if(r.status===404) {if(!object(e,['error'])||!object(e.error,['code','message'])||e.error.code!=='rejected'||e.error.message!=='Request rejected') throw new Error('Invalid absent reply');json(res,404,{error:'source_absent'});return;}
      if(r.status!==200||!event(e)||e.id!==v.id||e.stamp.replica!==v.from) throw new Error('Invalid source');
      const out=await fetch(`${target}/receive`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(e),redirect:'error',signal:controller.signal});
      const body=await bounded(out);
      if([409,422,429].includes(out.status)) {
        if(!object(body,['error'])||!object(body.error,['code','message'])||body.error.code!=='rejected'||body.error.message!=='Request rejected') throw new Error('Invalid error');
        json(res,out.status,body);return;
      }
      if((out.status!==200&&out.status!==201)||!object(body,['clock'])||!clock(body.clock)) throw new Error('Invalid receiver');
      json(res,200,body);
    } catch {json(res,502,{error:'upstream_failure'});} finally {clearTimeout(timer);}
  });
}
if(import.meta.main) await main();
