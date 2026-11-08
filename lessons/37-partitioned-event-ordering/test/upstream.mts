// Independent-process upstream fixture; no listener or configuration on import.
import { serve,json } from '../../../lib/http.mts';

export async function main() {
  const mode=process.env.VARIANT??'valid';
  let entered=0,aborted=0;
  const pending=new Set<()=>void>();
  const events=Array.from({length:8},(_,i)=>({id:`e${i}${'x'.repeat(62)}`,key:'c'.repeat(32),delta:1,partition:0,offset:i+1}));
  const envelope={partition:0,after:0,events};
  const serialized=JSON.stringify(envelope).replace(/"([^"]*)"/g,(_match:string,text:string)=>'"'+Array.from(text,c=>`\\u${c.charCodeAt(0).toString(16).padStart(4,'0')}`).join('')+'"');
  await serve('upstream-fixture',0,async(req,res)=>{
    const path=new URL(req.url??'/', 'http://local').pathname;
    if(path==='/stats') {json(res,200,{entered,aborted});return;}
    if(path==='/release' && req.method==='POST') {
      for(const release of pending)release();pending.clear();json(res,200,{released:true});return;
    }
    if(path!=='/events') {json(res,404,{});return;}
    entered++;
    if(mode==='redirect') {res.writeHead(307,{location:`${process.env.TARGET_ORIGIN}/events`});res.end();return;}
    if(mode==='hold' || mode==='stream') {
      const release=()=>{
        if(!res.destroyed) {
          if(mode==='stream')res.end(serialized.slice(1));
          else json(res,200,envelope);
        }
      };
      pending.add(release);
      res.once('close',()=>{pending.delete(release);if(!res.writableFinished)aborted++;});
      if(mode==='stream') {res.writeHead(200,{'content-type':'application/json'});res.write('{');}
      return;
    }
    if(mode==='malformed') {
      json(res,200,{...envelope,events:[events[0],{...events[1],delta:'1'}]});return;
    }
    if(mode==='sequence') {
      json(res,200,{...envelope,events:[events[0],{...events[1],offset:3}]});return;
    }
    if(mode==='identity') {
      json(res,200,{...envelope,events:[events[0],{...events[1],id:events[0]?.id}]});return;
    }
    if(mode==='envelope') {json(res,200,{...envelope,partition:'0'});return;}
    res.writeHead(200,{'content-type':'application/json'});
    // Both variants are valid JSON and the same legal contiguous event batch.
    res.end(mode==='oversized'?serialized+' '.repeat(8193):serialized);
  });
}
if(import.meta.main) await main();
