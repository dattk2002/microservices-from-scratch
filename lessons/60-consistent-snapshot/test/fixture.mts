import { serve,json,readJson } from '../../../lib/http.mts';
import { exact,integer,fail } from '../protocol.mts';
import { origin } from '../channel.mts';
type Config={mode:string;body:unknown;status:number;delay:number};
export async function main() {
 const sink=process.env.SINK_ORIGIN===undefined?undefined:origin(process.env.SINK_ORIGIN);
 const configs=new Map<string,Config>(); const counts:Record<string,number>={};
 await serve('snapshot-fixture',0,async(req,res)=>{
  const route=req.url??'/';
  if(route==='/control'&&req.method==='POST') {
   if(process.env.TEACHING_CONTROLS!=='1') fail(404,'not_found');
   const b=await readJson(req);
   if(!exact(b,['route','mode','body','status','delay'])||typeof b.route!=='string'||!['/head','/ack','/messages','/snapshot'].includes(b.route)||typeof b.mode!=='string'||!['json','escaped','oversize','redirect','slow','drop'].includes(b.mode)||!integer(b.status,100,599)||!integer(b.delay,0,1000)) fail(400,'invalid_control');
   configs.set(b.route,{mode:b.mode,body:b.body,status:b.status,delay:b.delay}); return json(res,200,{ok:true});
  }
  if(route==='/counts') return json(res,200,counts);
  counts[route]=(counts[route]??0)+1;
  if(req.method==='POST') await readJson(req);
  if(route==='/sink') return json(res,200,{ok:true});
  const c=configs.get(route); if(!c) return json(res,200,{seq:1});
  if(c.delay) await new Promise<void>(resolve=>setTimeout(resolve,c.delay));
  if(res.destroyed) return;
  if(c.mode==='drop') { res.destroy(); return; }
  if(c.mode==='redirect') { if(!sink) throw new Error('SINK_ORIGIN required'); res.writeHead(307,{location:sink+'/sink'}); res.end(); return; }
  let wire=JSON.stringify(c.body);
  // Replace decoded string tokens only, preserving numeric/boolean/null tokens.
  if(c.mode==='escaped') wire=wire.replace(/"(?:[^"\\]|\\.)*"/g,token=>{
   const decoded:unknown=JSON.parse(token); if(typeof decoded!=='string') throw new Error('String token expected');
   return '"'+Array.from(decoded).map(ch=>'\\u'+ch.charCodeAt(0).toString(16).padStart(4,'0')).join('')+'"';
  });
  if(c.mode==='oversize') wire+=' '.repeat(20000);
  res.writeHead(c.status,{'content-type':'application/json'});
  if(c.mode==='slow') {
   res.write(wire.slice(0,1));
   await new Promise<void>(resolve=>setTimeout(resolve,650));
   if(!res.destroyed) res.end(wire.slice(1));
  } else res.end(wire);
 });
}
if(import.meta.main) await main();
