// One bounded fixture process, reconfigured between cases; never imported by runtime.
import { serve,json,readJson } from '../../../lib/http.mts';
import { object } from '../contracts.mts';
export async function main(){
  let mode='normal',destination='',calls=0;
  const held=new Set<()=>void>();
  return serve('fixture',0,async(req,res)=>{
    if(req.url==='/held'){json(res,200,{active:held.size});return;}
    if(req.url==='/release'){held.values().next().value?.();json(res,200,{ok:true});return;}
    if(req.url==='/state'){json(res,200,{calls});return;}
    if(req.url==='/mode'){
      const body=object(await readJson(req),['mode','destination']);
      if(typeof body.mode!=='string'||typeof body.destination!=='string')throw new Error('Invalid fixture config');
      mode=body.mode;destination=body.destination;json(res,200,{ok:true});return;
    }
    calls=Math.min(65535,calls+1);
    if(mode==='hold'){
      if(held.size>=4){json(res,503,{error:{code:'unavailable',message:'Worker unavailable'}});return;}
      await new Promise<void>(resolve=>{const release=()=>{clearTimeout(timer);held.delete(release);res.off('close',release);resolve();};const timer=setTimeout(release,800);held.add(release);res.once('close',release);});
      if(res.destroyed)return;
    }
    if(mode==='redirect'){res.writeHead(307,{location:destination+'/lookup'});res.end();return;}
    if(mode==='slow'){
      res.writeHead(200,{'content-type':'application/json'});res.write('{');
      await new Promise<void>(resolve=>{const finish=()=>{clearTimeout(timer);res.off('close',finish);resolve();};const timer=setTimeout(finish,700);res.once('close',finish);});
      if(!res.destroyed)res.end('"id":"a","value":10}');return;
    }
    const escapeStrings=(value:unknown):string=>JSON.stringify(value).replace(/"(?:[^"\\]|\\.)*"/g,token=>{
      const decoded:unknown=JSON.parse(token);
      if(typeof decoded!=='string')throw new Error('Expected string');
      return '"'+Array.from(decoded,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('')+'"';
    });
    if(mode==='escaped'){res.end(escapeStrings({id:'a',value:10}));return;}
    // Whitespace is valid JSON; all identity/schema fields remain correct.
    if(mode==='oversize'){res.end(' '.repeat(513)+'{"id":"a","value":10}');return;}
    if(mode==='wrong-value'){json(res,200,{id:'a',value:20});return;}
    if(mode==='extra'){json(res,200,{id:'a',value:10,extra:true});return;}
    if(mode==='primitive'){json(res,200,10);return;}
    if(mode.startsWith('404-')||mode.startsWith('503-')){
      const status=mode.startsWith('404-')?404:503;
      const suffix=mode.slice(4);
      json(res,status,suffix==='valid'?{error:{code:status===404?'not_found':'unavailable',message:status===404?'Unknown id':'Worker unavailable'}}:suffix==='unexpected'?{error:{code:'internal_error',message:'Unexpected service error'}}:suffix==='array'?[]:suffix==='primitive'?17:suffix==='null'?null:{error:{code:4,message:null}});return;
    }
    json(res,200,{id:'a',value:10});
  });
}
if(import.meta.main)await main();
