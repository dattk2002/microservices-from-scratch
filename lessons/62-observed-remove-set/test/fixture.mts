import { HttpError, json, readJson, serve } from '../../../lib/http.mts';
import { object } from '../state.mts';
const modes=['normal','primitive','array','extra','gap','duplicate','unsorted','unknown-removal','bad-json','unexpected-status','wrong-error','unexpected-code','oversize','slow','half-slow','redirect','conflict','escaped','error-primitive','error-array','error-extra','wrong-message','rejected422','rejected429','not-found','wrong-content-type','unfinished-content-type'];
export const full = {adds:['a','b'].flatMap(actor=>Array.from({length:8},(_,i)=>({actor,seq:i+1,element:'green'}))),removed:['a','b'].flatMap(actor=>Array.from({length:8},(_,i)=>({actor,seq:i+1})))};
// Match complete JSON string tokens, decode, then escape their characters only.
export function escapeStrings(value: unknown): string {
  return JSON.stringify(value).replace(/"(?:[^"\\]|\\.)*"/g, token=> {
    const decoded: unknown=JSON.parse(token);
    if(typeof decoded!=='string') throw new Error('Not a string');
    return '"'+Array.from(decoded,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('')+'"';
  });
}
export async function main() {
  const controls=process.env.TEACHING_CONTROLS==='1';
  const redirect=process.env.REDIRECT_ORIGIN;
  const config={state:'normal',merge:'normal'}; let count=0;
  let active=0; let closed=0;
  const timers=new Set<ReturnType<typeof setTimeout>>();
  const server=await serve('orset-fixture',6265,async(req,res)=>{
    if(req.url==='/control' && req.method==='POST' && controls) {
      const input=await readJson(req);
      if(!object(input,['route','mode']) || (input.route!=='state' && input.route!=='merge') || typeof input.mode!=='string' || !modes.includes(input.mode)) throw new HttpError(400,'invalid_body','Invalid request body');
      config[input.route]=input.mode; json(res,200,{ok:true}); return;
    }
    if(req.url==='/count' && req.method==='GET' && controls) {json(res,200,{count});return;}
    if(req.url==='/pending' && req.method==='GET' && controls) {json(res,200,{active,closed});return;}
    if(req.url!=='/state' && req.url!=='/merge' && req.url!=='/sink') throw new HttpError(404,'not_found','Route not found');
    count++;
    if(req.method==='POST') await readJson(req);
    const mode=req.url==='/state'?config.state:config.merge;
    if(mode==='unfinished-content-type') {
      if(active>=16) throw new HttpError(503,'fixture_busy','Pending response limit reached');
      active++;
      res.once('close',()=>{active--; closed=Math.min(closed+1,16);});
      res.writeHead(200,{'content-type':'text/plain'}); res.write('{'); return;
    }
    if(mode==='redirect') {res.writeHead(307,{location:(redirect??'http://127.0.0.1:1')+'/sink'});res.end();return;}
    const empty={adds:[],removed:[]};
    let value: unknown=empty; let status=200;
    switch(mode) {
      case 'error-primitive': status=req.url==='/state'?404:409;value=null;break;
      case 'error-array': status=req.url==='/state'?404:409;value=[];break;
      case 'error-extra': status=req.url==='/state'?404:409;value={error:{code:'conflicting_tag',message:'Tag already names another element',extra:1}};break;
      case 'wrong-message': status=req.url==='/state'?404:409;value={error:{code:'conflicting_tag',message:'Internal failure'}};break;
      case 'rejected422': case 'rejected429': status=mode==='rejected422'?422:429;value={error:{code:'conflicting_tag',message:'Tag already names another element'}};break;
      case 'not-found': status=404;break;
      case 'primitive': value=null; break;
      case 'array': value=[]; break;
      case 'extra': value={...empty,extra:1};break;
      case 'gap': value={adds:[{actor:'a',seq:2,element:'red'}],removed:[]};break;
      case 'duplicate': value={adds:[{actor:'a',seq:1,element:'red'},{actor:'a',seq:1,element:'red'}],removed:[]};break;
      case 'unsorted': value={adds:[{actor:'b',seq:1,element:'red'},{actor:'a',seq:1,element:'red'}],removed:[]};break;
      case 'unknown-removal': value={adds:[],removed:[{actor:'b',seq:1}]};break;
      case 'unexpected-status': status=503;break;
      case 'wrong-error': status=req.url==='/state'?404:409;value={error:{code:42,message:'bad'}};break;
      case 'unexpected-code': status=req.url==='/state'?404:409;value={error:{code:'internal_error',message:'Unexpected service error'}};break;
      case 'conflict': status=409;value={error:{code:'conflicting_tag',message:'Tag already names another element'}};break;
      case 'oversize': case 'escaped': value=full;break;
    }
    const wire=mode==='bad-json'?'{':mode==='escaped'?escapeStrings(value):mode==='oversize'?JSON.stringify(value)+' '.repeat(8193):JSON.stringify(value);
    res.writeHead(status,{'content-type':mode==='wrong-content-type'?'text/plain':'application/json'});
    if(mode==='slow' || mode==='half-slow') {
      res.write(wire.slice(0,1));
      const timer=setTimeout(()=>{timers.delete(timer);res.end(wire.slice(1));},mode==='slow'?650:300);
      timers.add(timer); res.once('close',()=>{clearTimeout(timer);timers.delete(timer);});
    } else res.end(wire);
  });
  server.once('close',()=>{for(const timer of timers) clearTimeout(timer);});
  return server;
}
if(import.meta.main) main().catch((error:unknown)=>{console.error(error instanceof Error?error.message:'Startup failed');process.exitCode=1;});
