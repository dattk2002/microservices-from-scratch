// Process-isolated local HTTP adversary; no outbound traffic or durable state.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, readJson, serve } from '../../../lib/http.mts';
import { exact, invalid, origins } from '../ranking.mts';

const modes=new Set(['ok','null','array','primitive','extra','wrong-shard','wrong-revision','unsorted','duplicate','foreign','len','score','score-type','item-extra','unknown','error-code','error-message','error-null','error-array','error-extra','status409','status422','status429','status503','media','json','utf8','disconnect','oversize','chunked-oversize','escaped','slow-headers','slow-body','slow-error-body','slow-chain','redirect']);
function escaped(data:unknown):string {
  return JSON.stringify(data).replace(/"(?:[^"\\]|\\.)*"/g,token=>{
    const value:unknown=JSON.parse(token);if(typeof value!=='string') throw new Error('Expected JSON string token');
    return '"'+Array.from(value,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('')+'"';
  });
}
export async function main():Promise<void> {
  const sink=process.env.FIXTURE_ROLE==='sink',shard=process.env.SHARD_ID;
  if(!sink&&shard!=='a'&&shard!=='b') throw new Error('SHARD_ID required');
  const redirect=process.env.REDIRECT_ORIGIN;
  // Validate without performing an outbound request.
  if(!sink) origins(redirect??'','http://127.0.0.1:1');
  let mode='ok',received=0;
  const handler=async(req:IncomingMessage,res:ServerResponse):Promise<void>=>{
    const url=new URL(req.url??'/','http://fixture');
    if(url.pathname==='/stats') {json(res,200,{received});return;}
    if(sink) {received++;json(res,200,{});return;}
    if(url.pathname==='/mode'&&req.method==='POST') {
      const body=await readJson(req);
      if(!exact(body,['mode'])||typeof body.mode!=='string'||!modes.has(body.mode)) invalid();
      mode=body.mode;json(res,200,{mode});return;
    }
    const valid={shard,revision:1,items:[{id:shard+'0',score:90},{id:shard+'1',score:80}]};
    let data:unknown=valid,status=200;
    if(mode==='redirect') {res.writeHead(307,{location:redirect+'/received'});res.end();return;}
    if(mode==='null') data=null;
    if(mode==='array') data=[];
    if(mode==='primitive') data=true;
    if(mode==='extra') data={...valid,extra:1};
    if(mode==='wrong-shard') data={...valid,shard:shard==='a'?'b':'a'};
    if(mode==='wrong-revision') data={...valid,revision:0};
    if(mode==='unsorted') data={...valid,items:valid.items.toReversed()};
    if(mode==='duplicate') data={...valid,items:[valid.items[0],valid.items[0]]};
    if(mode==='foreign') data={...valid,items:[{id:shard==='a'?'b0':'a0',score:90}]};
    if(mode==='len') data={...valid,items:[0,1,2,3].map(i=>({id:shard+String(i),score:90-i}))};
    if(mode==='score') data={...valid,items:[{id:shard+'0',score:101}]};
    if(mode==='score-type') data={...valid,items:[{id:shard+'0',score:'90'}]};
    if(mode==='item-extra') data={...valid,items:[{id:shard+'0',score:90,extra:true}]};
    if(mode==='unknown'||mode.startsWith('error-')||mode==='slow-error-body') {
      status=404;data={error:{code:'unknown_snapshot',message:'unknown_snapshot'}};
      if(mode==='error-code') data={error:{code:'internal_error',message:'internal_error'}};
      if(mode==='error-message') data={error:{code:'unknown_snapshot',message:'wrong'}};
      if(mode==='error-null') data={error:null};
      if(mode==='error-array') data={error:[]};
      if(mode==='error-extra') data={error:{code:'unknown_snapshot',message:'unknown_snapshot',extra:1}};
    }
    if(mode.startsWith('status')) {status=Number(mode.slice(6));data={error:{code:'internal_error',message:'internal_error'}};}
    const wire=mode==='escaped'?escaped(data):JSON.stringify(data)+(mode==='oversize'||mode==='chunked-oversize'?' '.repeat(8192):'');
    if(mode==='slow-headers'||mode==='slow-chain') {
      await new Promise<void>(resolve=>{
        const timer=setTimeout(resolve,mode==='slow-chain'?300:800);res.once('close',()=>{clearTimeout(timer);resolve();});
      });
      if(res.destroyed) return;
    }
    res.writeHead(status,{'content-type':mode==='media'?'text/plain':'application/json'});
    if(mode==='disconnect') {res.write('{');res.socket?.destroy();return;}
    if(mode==='slow-body'||mode==='slow-error-body'||mode==='slow-chain') {
      res.write(wire.slice(0,1));
      const timer=setTimeout(()=>res.end(wire.slice(1)),mode==='slow-chain'?300:800);res.once('close',()=>clearTimeout(timer));return;
    }
    if(mode==='chunked-oversize') {res.write(wire.slice(0,40));res.end(wire.slice(40));return;}
    res.end(mode==='utf8'?Buffer.from([0xff]):mode==='json'?'{':wire);
  };
  await serve('top-k-fixture',0,handler);
}
if(import.meta.main) main().catch((error:unknown)=>{console.error(error instanceof Error?error.message:'Startup failed');process.exitCode=1;});
