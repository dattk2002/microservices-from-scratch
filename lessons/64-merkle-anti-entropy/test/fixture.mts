import { serve,json,HttpError,methodNotAllowed } from '../../../lib/http.mts';
import { exact,invalid,publicBody,query } from '../protocol.mts';
import { Pair,escaped,semantic,oracle } from './oracle.mts';

const modes=['ok','escaped','oversize','chunked-oversize','redirect','redirect-apply','later-oversize','slow-headers','slow-body','slow-chain','node-stale','record-stale','apply-stale','apply-capacity','unexpected-conflict','unexpected-capacity','primitive-conflict','later-invalid','forged-child','forged-revision','wrong-identity','node-array','concurrent','lost-apply'];
export async function main():Promise<void> {
  const role=process.env.FIXTURE_ROLE;
  if(role!=='source'&&role!=='target'&&role!=='sink') throw new Error('Invalid FIXTURE_ROLE');
  const redirect=process.env.REDIRECT_ORIGIN;
  if(role!=='sink'&&(!redirect||new URL(redirect).origin!==redirect)) throw new Error('Invalid REDIRECT_ORIGIN');
  let mode='ok';
  const p=new Pair();p.source[0]='A';p.source[7]='H';p.sourceRevision=2;
  const counts={root:0,node:0,record:0,apply:0,received:0};
  await serve('merkle-fixture',0,async(req,res)=>{
    const url=new URL(req.url??'/','http://fixture');
    if(url.pathname.startsWith('/teaching/')) {
      if(process.env.TEACHING_CONTROLS!=='1') throw new HttpError(404,'not_found','Route not found');
      if(url.pathname==='/teaching/stats') {
        if(req.method!=='GET') methodNotAllowed(res,'GET');query(url,[]);
        json(res,200,{...counts,target:p.target,targetRevision:p.targetRevision});return;
      }
      if(url.pathname!=='/teaching/mode') throw new HttpError(404,'not_found','Route not found');
      if(req.method!=='POST') methodNotAllowed(res,'POST');query(url,[]);
      const body=await publicBody(req);
      if(!exact(body,['mode'])||typeof body.mode!=='string'||!modes.includes(body.mode)) invalid();
      mode=body.mode;p.target.fill(null);p.targetRevision=0;json(res,200,{mode});return;
    }
    if(role==='sink') {counts.received++;req.resume();json(res,200,{});return;}
    if(url.pathname==='/root') counts.root++;
    else if(url.pathname==='/node') counts.node++;
    else if(url.pathname==='/record') counts.record++;
    else if(url.pathname==='/apply') counts.apply++;
    else throw new HttpError(404,'not_found','Route not found');
    const body=req.method==='POST'?await publicBody(req):undefined;
    if(mode==='redirect'||(mode==='redirect-apply'&&url.pathname==='/apply')) {res.writeHead(307,{location:redirect+'/captured'});res.end();return;}
    if(mode==='slow-headers'||mode==='slow-chain') {
      const delay=mode==='slow-headers'?1200:220;
      await new Promise<void>(resolve=>{
        const t=setTimeout(()=>{res.off('close',closed);resolve();},delay);
        const closed=()=>{clearTimeout(t);resolve();};res.once('close',closed);
      });
      if(res.destroyed) return;
    }
    let response:Response;
    if((mode==='node-stale'||mode==='unexpected-conflict'||mode==='primitive-conflict')&&url.pathname==='/node') {
      response=mode==='node-stale'?semantic(409):Response.json(mode==='primitive-conflict'?[]:{error:{code:'internal_error',message:'Revision changed'}},{status:409});
    } else if(mode==='record-stale'&&url.pathname==='/record') response=semantic(409);
    else if(mode==='apply-stale'&&url.pathname==='/apply') response=semantic(409);
    else if(mode==='apply-capacity'&&url.pathname==='/apply') response=semantic(429);
    else if(mode==='unexpected-capacity'&&url.pathname==='/apply') response=Response.json({error:{code:'internal_error',message:'Revision limit reached'}},{status:429});
    else {
      if(mode==='concurrent'&&url.pathname==='/apply') {p.target[3]='concurrent';p.targetRevision++;}
      response=p.respond(role,url,body);
    }
    let data:unknown=await response.json();
    if(mode==='later-invalid'&&url.pathname==='/record'&&url.searchParams.get('key')==='k7'&&exact(data,['revision','key','value','hash'])) data={...data,value:'corrupt'};
    if(url.pathname==='/node'&&url.searchParams.get('path')==='1'&&exact(data,['revision','path','hash','children'])) {
      const base=data;
      if(mode==='forged-child') {
        // Self-consistent subtree, but not the hash committed by its parent.
        const fake=oracle(Array<string>(8).fill('fake'));
        data={...base,hash:fake.get('1'),children:{left:fake.get('10'),right:fake.get('11')}};
      }
      if(mode==='forged-revision') data={...base,revision:0};
      if(mode==='wrong-identity') data={...base,path:'0'};
    }
    if(mode==='node-array'&&url.pathname==='/node') data=[];
    if(mode==='lost-apply'&&url.pathname==='/apply') {req.socket.destroy();return;}
    const wire=(mode==='escaped'||mode==='oversize'||mode==='chunked-oversize'?escaped(data):JSON.stringify(data))+((mode==='oversize'||mode==='chunked-oversize'||(mode==='later-oversize'&&url.pathname==='/record'&&url.searchParams.get('key')==='k7'))?' '.repeat(4096):'');
    if(mode==='slow-body') {
      res.writeHead(response.status,{'content-type':'application/json'});res.write(wire.slice(0,1));
      const t=setTimeout(()=>res.end(wire.slice(1)),1200);res.once('close',()=>clearTimeout(t));return;
    }
    res.writeHead(response.status,{'content-type':'application/json',...(mode==='chunked-oversize'?{}:{'content-length':String(Buffer.byteLength(wire))})});
    if(mode==='chunked-oversize') {res.write(wire.slice(0,2000));res.end(wire.slice(2000));}
    else res.end(wire);
  });
}
if(import.meta.main) main().catch((e:unknown)=>{console.error(e instanceof Error?e.message:'Startup failed');process.exitCode=1;});
