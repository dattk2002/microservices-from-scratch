// Bounded HTTP doubles are independent processes, controlled only in teaching mode.
import { HttpError, json, readJson, serve } from '../../../lib/http.mts';
import { exact, isEvent, messages } from '../core.mts';
import { WIRE_LIMIT } from '../relay.mts';
const modes=['good','buffered','replay_buffered','conflict','full','unknown','unexpected_code','unexpected_full_code','wrong_message','error_primitive','error_array','error_extra','primitive','array','extra','invalid','oversize','escaped','redirect','slow_headers','slow_body','slow_pair','transport','wrong_tuple','wrong_clock','unexpected_status','wrong_type'] as const;
type Mode=typeof modes[number];
function isMode(value:unknown):value is Mode {return typeof value==='string' && modes.some(m=>m===value);}
function escaped(value:unknown) {
  // Transform decoded STRING tokens only. Number/boolean/null tokens stay JSON.
  return JSON.stringify(value).replace(/"(?:\\.|[^"\\])*"/g,token=>{
    const decoded:unknown=JSON.parse(token);
    if(typeof decoded!=='string') throw new Error('Expected string token');
    return '"'+Array.from(decoded,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('')+'"';
  });
}
export async function main() {
  const controls=process.env.TEACHING_CONTROLS==='1';
  const redirectOrigin=process.env.REDIRECT_ORIGIN;
  let mode:Mode='good', requests=0,receives=0;
  return serve('causal-upstream',5063,async(req,res)=>{
    if(req.url==='/control'&&req.method==='POST'&&controls) {
      const body=await readJson(req);
      if(!exact(body,['mode'])||!isMode(body.mode)) throw new HttpError(400,'invalid_request','Invalid mode');
      mode=body.mode;json(res,200,{mode});return;
    }
    if(req.url==='/stats'&&req.method==='GET'&&controls) {json(res,200,{requests,receives});return;}
    const source=req.method==='GET'&&/^\/events\/[abc]\/[1-8]$/.test(req.url??'');
    const target=req.method==='POST'&&req.url==='/receive';
    if(!source&&!target) throw new HttpError(404,'not_found','Unknown route');
    requests++;
    if(target) {
      if(!isEvent(await readJson(req))) throw new HttpError(400,'invalid_request','Invalid event');
      receives++;
    }
    const selected=mode;
    if(selected==='transport') {req.socket.destroy();return;}
    if(selected==='redirect') {
      if(!redirectOrigin) throw new Error('Missing REDIRECT_ORIGIN');
      res.writeHead(307,{location:redirectOrigin+(source?'/events/a/1':'/receive')});res.end();return;
    }
    let status=200;
    let body:unknown=source?{sender:'a',seq:1,clock:{a:1,b:0,c:0},value:'abcdefghijklmnop'}:{status:'delivered'};
    if(selected==='buffered') {status=202;body={status:'buffered'};}
    if(selected==='replay_buffered') body={status:'buffered'};
    const semantic=source?'unknown_event':selected==='full'||selected==='unexpected_full_code'?'buffer_full':'event_conflict';
    if(['unknown','conflict','full','unexpected_code','unexpected_full_code','wrong_message'].includes(selected)) {
      status=source?404:selected==='full'||selected==='unexpected_full_code'?429:409;
      body={error:{code:selected==='unexpected_code'||selected==='unexpected_full_code'?'internal_error':semantic,message:selected==='wrong_message'?'Unexpected':messages[semantic]}};
    }
    if(['error_primitive','error_array','error_extra'].includes(selected)) {
      status=source?404:409;
      body=selected==='error_primitive'?null:selected==='error_array'?[]:{error:{code:semantic,message:messages[semantic]},extra:true};
    }
    if(selected==='primitive') body=true;
    if(selected==='array') body=[];
    if(selected==='extra') body=source?{sender:'a',seq:1,clock:{a:1,b:0,c:0},value:'x',extra:1}:{status:'delivered',extra:1};
    if(selected==='wrong_tuple') body={sender:'b',seq:1,clock:{a:0,b:1,c:0},value:'x'};
    if(selected==='wrong_clock') body={sender:'a',seq:1,clock:{a:2,b:0,c:0},value:'x'};
    if(selected==='unexpected_status') status=503;
    const wait=(ms:number)=>new Promise<void>(resolve=>{
      const timer=setTimeout(resolve,ms);
      res.once('close',()=>{clearTimeout(timer);resolve();});
    });
    if(selected==='slow_headers') await wait(650);
    if(selected==='slow_pair') await wait(300);
    if(res.destroyed) return;
    res.writeHead(status,{'content-type':selected==='wrong_type'?'text/plain':'application/json'});
    if(selected==='slow_body') {res.write(' ');await wait(650);}
    if(res.destroyed) return;
    const wire=selected==='escaped'||selected==='oversize'?escaped(body):JSON.stringify(body);
    res.end(selected==='invalid'?'{':selected==='oversize'?wire+' '.repeat(WIRE_LIMIT):wire);
  });
}
if(import.meta.main) await main();
