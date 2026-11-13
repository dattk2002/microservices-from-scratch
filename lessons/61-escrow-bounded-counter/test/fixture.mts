import { HttpError, json, readJson, serve } from '../../../lib/http.mts';
import { exact, invalid, origin } from '../model.mts';
import { UPSTREAM_BYTES } from '../sync.mts';

type Mode='json'|'escaped'|'oversize'|'malformed'|'redirect'|'drop'|'body-slow';
type Reply={mode:Mode;body:unknown;status:number;delay:number};
function mode(value:unknown):Mode {
  if(value!=='json' && value!=='escaped' && value!=='oversize' && value!=='malformed' && value!=='redirect' && value!=='drop' && value!=='body-slow') return invalid();
  return value;
}
function escaped(body:unknown):string {
  // Transform decoded JSON STRING tokens only; numbers/true/false/null stay intact.
  return JSON.stringify(body).replace(/"(?:[^"\\]|\\.)*"/g,token=>{
    const decoded:unknown=JSON.parse(token);
    if(typeof decoded!=='string') throw new Error('Expected string token');
    return '"'+decoded.split('').map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('')+'"';
  });
}
export async function main() {
  const controls=process.env.TEACHING_CONTROLS==='1';
  const sink=controls?origin(process.env.SINK_ORIGIN):undefined;
  const replies:Record<'/state'|'/merge',Reply>={
    '/state':{mode:'json',body:null,status:200,delay:0},
    '/merge':{mode:'json',body:null,status:200,delay:0},
  };
  const counts={state:0,merge:0,sink:0};
  let received:unknown=null;
  return serve('escrow-fixture',0,async(req,res)=>{
    if(req.method==='GET' && req.url==='/counts') return json(res,200,counts);
    if(req.method==='GET' && req.url==='/received') return json(res,200,{body:received});
    if(req.url==='/control' && req.method==='POST') {
      if(!controls) throw new HttpError(404,'not_found','Controls disabled');
      const v=await readJson(req);
      if(!exact(v,['route','mode','body','status','delay']) || (v.route!=='/state' && v.route!=='/merge') || typeof v.status!=='number' || !Number.isInteger(v.status) || v.status<200 || v.status>599 || typeof v.delay!=='number' || !Number.isInteger(v.delay) || v.delay<0 || v.delay>700) return invalid();
      const selected=mode(v.mode);
      replies[v.route]={mode:selected,body:v.body,status:v.status,delay:v.delay};
      return json(res,200,{});
    }
    if(req.url==='/sink') { counts.sink++; return json(res,200,{}); }
    const route=req.url;
    if((route!=='/state' || req.method!=='GET') && (route!=='/merge' || req.method!=='POST')) return json(res,404,{});
    if(route==='/merge') { counts.merge++; received=await readJson(req); }
    else counts.state++;
    const reply=replies[route];
    if(reply.mode==='redirect') { res.writeHead(307,{location:`${sink}/sink`}); res.end(); return; }
    if(reply.mode==='drop') { req.socket.destroy(); return; }
    if(reply.delay>0) await new Promise<void>(resolve=>setTimeout(resolve,reply.delay));
    res.writeHead(reply.status,{'content-type':'application/json'});
    if(reply.mode==='body-slow') {
      res.write(' ');
      await new Promise<void>(resolve=>setTimeout(resolve,700));
      res.end(JSON.stringify(reply.body)); return;
    }
    if(reply.mode==='malformed') { res.end('{'); return; }
    const wire=reply.mode==='escaped'||reply.mode==='oversize'?escaped(reply.body):JSON.stringify(reply.body);
    res.end((reply.mode==='oversize'?' '.repeat(UPSTREAM_BYTES+1):'')+wire);
  });
}
if(import.meta.main) await main();
