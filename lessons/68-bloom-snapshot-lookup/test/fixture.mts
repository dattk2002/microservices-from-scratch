// Local-only adversarial HTTP peer. It never contacts external services.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { serve, json, readJson, HttpError } from '../../../lib/http.mts';
import { exact, invalid } from '../protocol.mts';
import { normalizeOrigin } from '../lookup.mts';

const variants=['null','array','primitive','extra','wrong-revision','wrong-code','wrong-message','error-primitive','error-array','error-extra','unavailable','status409','status422','status429','oversize','chunked-oversize','error-oversize','error-slow-body','utf8','media','uncertain','unknown','escaped','redirect','slow-headers','slow-body'];
const modes=new Set(['ok','slow-chain','item-absent',...['filter','item'].flatMap(b=>variants.map(v=>`${b}-${v}`))]);
function escaped(data:unknown):string {
  // Re-encode STRING TOKENS only; booleans, null and numbers stay JSON tokens.
  return JSON.stringify(data).replace(/"(?:[^"\\]|\\.)*"/g,token=>{
    const s:unknown=JSON.parse(token);if(typeof s!=='string') throw new Error('Not a string token');
    return '"'+Array.from(s,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('')+'"';
  });
}
export async function main():Promise<void> {
  const sink=process.env.FIXTURE_ROLE==='sink';
  const redirect=sink?undefined:normalizeOrigin(process.env.REDIRECT_ORIGIN??'');
  let mode='ok';const counts={filters:0,items:0,received:0};
  const handler=async(req:IncomingMessage,res:ServerResponse):Promise<void>=>{
    const url=new URL(req.url??'/','http://fixture');
    if(url.pathname==='/stats') {json(res,200,counts);return;}
    if(url.pathname==='/mode'&&req.method==='POST') {
      const b=await readJson(req);if(!exact(b,['mode'])||typeof b.mode!=='string'||!modes.has(b.mode)) invalid();
      mode=b.mode;json(res,200,{mode});return;
    }
    if(sink) {counts.received++;json(res,200,{});return;}
    const branch=url.pathname==='/filter/1'?'filter':url.pathname==='/snapshots/1/items/k1'?'item':undefined;
    if(!branch) throw new HttpError(404,'not_found','not_found');
    if(branch==='filter') counts.filters++;else counts.items++;
    const variant=mode.startsWith(branch+'-')?mode.slice(branch.length+1):'ok';
    const valid=branch==='filter'?{revision:1,m:32,k:2,bits:'00000900'}:{revision:1,key:'k1',value:'A'};
    let data:unknown=valid,status=200;
    if(variant==='redirect') {res.writeHead(307,{location:redirect+'/received'});res.end();return;}
    if(variant==='uncertain') {res.writeHead(200,{'content-type':'application/json'});res.write('{');res.socket?.destroy();return;}
    if(variant==='null') data=null;
    if(variant==='array') data=[];
    if(variant==='primitive') data=true;
    if(variant==='extra') data={...valid,extra:1};
    if(variant==='wrong-revision') data={...valid,revision:0};
    if(['wrong-code','wrong-message','error-primitive','error-array','error-extra','unknown','absent','error-oversize','error-slow-body'].includes(variant)) {
      status=404;data={error:{code:'unknown_snapshot',message:'unknown_snapshot'}};
      if(variant==='wrong-code') data={error:{code:'internal_error',message:'unknown_snapshot'}};
      if(variant==='wrong-message') data={error:{code:'unknown_snapshot',message:'oops'}};
      if(variant==='error-primitive') data={error:false};
      if(variant==='error-array') data={error:[]};
      if(variant==='error-extra') data={error:{code:'unknown_snapshot',message:'unknown_snapshot',extra:1}};
      if(variant==='absent') data={error:{code:'absent',message:'absent'}};
    }
    if(variant==='unavailable') {status=503;data={error:{code:'busy',message:'busy'}};}
    if(variant.startsWith('status')) {status=Number(variant.slice(6));data={error:{code:'internal_error',message:'internal_error'}};}
    const wire=variant==='escaped'?escaped(data):JSON.stringify(data)+(variant==='oversize'||variant==='chunked-oversize'||variant==='error-oversize'?' '.repeat(8192):'');
    if(variant==='slow-headers'||mode==='slow-chain') {
      await new Promise<void>(resolve=>{
        const timer=setTimeout(resolve,variant==='slow-headers'?800:300);
        res.once('close',()=>{clearTimeout(timer);resolve();});
      });
      if(res.destroyed) return;
    }
    res.writeHead(status,{'content-type':variant==='media'?'text/plain':'application/json'});
    if(variant==='slow-body'||variant==='error-slow-body') {
      res.write(wire.slice(0,1));
      const timer=setTimeout(()=>res.end(wire.slice(1)),800);
      res.once('close',()=>clearTimeout(timer));return;
    }
    if(variant==='chunked-oversize') {res.write(wire.slice(0,40));res.end(wire.slice(40));return;}
    res.end(variant==='utf8'?Buffer.from([0xff]):wire);
  };
  await serve('bloom-adversary',0,handler);
}
if(import.meta.main) main().catch((error:unknown)=>{console.error(error instanceof Error?error.message:'Startup failed');process.exitCode=1;});
