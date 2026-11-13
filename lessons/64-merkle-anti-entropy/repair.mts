import { performance } from 'node:perf_hooks';
import { serve,json,HttpError,methodNotAllowed } from '../../lib/http.mts';
import { BODY_LIMIT,KEYS,exact,revision,hash,value,branchHash,leafHash,invalid,stale,capacity,upstream,publicBody,query } from './protocol.mts';
import type { Root,TreeNode,PatchRecord } from './protocol.mts';

type Report={changed:string[],sourceRevision:number,targetRevision:number};
export function origins(source:unknown,target:unknown):[string,string] {
  const normalize=(raw:unknown):string=>{
    if(typeof raw!=='string') throw new Error('Missing origin');
    const u=new URL(raw);
    if(u.protocol!=='http:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash) throw new Error('Expected plain HTTP origin');
    return u.origin;
  };
  const a=normalize(source),b=normalize(target);
  if(a===b) throw new Error('SOURCE_ORIGIN and TARGET_ORIGIN must be distinct');
  return [a,b];
}
function errorEnvelope(body:unknown,code:string,message:string):boolean {
  return exact(body,['error'])&&exact(body.error,['code','message'])&&body.error.code===code&&body.error.message===message;
}
function root(body:unknown):Root {
  if(!exact(body,['revision','hash'])||!revision(body.revision)||!hash(body.hash)) upstream();
  return {revision:body.revision,hash:body.hash};
}
function node(body:unknown,p:string,r:number,commitment:string):TreeNode {
  if(!exact(body,['revision','path','hash','children'])||body.revision!==r||body.path!==p||!hash(body.hash)||body.hash!==commitment) upstream();
  if(p.length===3) {
    if(body.children!==null) upstream();
    return {revision:r,path:p,hash:body.hash,children:null};
  }
  const c=body.children;
  if(!exact(c,['left','right'])||!hash(c.left)||!hash(c.right)||branchHash(c.left,c.right)!==body.hash) upstream();
  return {revision:r,path:p,hash:body.hash,children:{left:c.left,right:c.right}};
}

export async function repairSnapshot(source:string,target:string,fetcher:typeof fetch=fetch):Promise<Report> {
  const [a,b]=origins(source,target);
  const deadline=performance.now()+1000;
  const abort=new AbortController();
  // One timer guards fetch headers, streamed bodies and the full multi-hop plan.
  let timer:ReturnType<typeof setTimeout>|undefined;
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(new Error('Deadline exceeded'));},1000);});
  const bounded=async<T,>(operation:Promise<T>):Promise<T>=>{
    const result=await Promise.race([operation,timeout]);
    if(performance.now()>=deadline) upstream();
    return result;
  };
  const request=async(origin:string,url:string,body?:unknown):Promise<unknown>=>{
    if(performance.now()>=deadline) upstream();
    const response=await bounded(fetcher(origin+url,{method:body===undefined?'GET':'POST',redirect:'error',signal:abort.signal,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})}));
    try {
      if(response.redirected||response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()!=='application/json') upstream();
      const length=response.headers.get('content-length');
      if(length!==null&&(!/^\d+$/.test(length)||Number(length)>BODY_LIMIT)) upstream();
      if(!response.body) upstream();
      const reader=response.body.getReader();
      const chunks:Uint8Array[]=[];let bytes=0;
      try {
        while(true) {
          const part=await bounded(reader.read());
          if(part.done) break;
          bytes+=part.value.byteLength;if(bytes>BODY_LIMIT) upstream();chunks.push(part.value);
        }
      } finally {void reader.cancel().catch(()=>{});reader.releaseLock();}
      const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
      const data:unknown=JSON.parse(text);
      if(response.status===409&&(url.startsWith('/node?')||url.startsWith('/record?')||url==='/apply')&&errorEnvelope(data,'revision_changed','Revision changed')) stale();
      if(response.status===429&&url==='/apply'&&errorEnvelope(data,'revision_limit','Revision limit reached')) capacity();
      if(response.status!==200) upstream();
      return data;
    } finally {if(response.body&&!response.body.locked) void response.body.cancel().catch(()=>{});}
  };
  try {
    const sr=root(await request(a,'/root'));
    const tr=root(await request(b,'/root'));
    if(sr.hash===tr.hash) return {changed:[],sourceRevision:sr.revision,targetRevision:tr.revision};
    const records:PatchRecord[]=[];
    const visit=async(p:string,sh:string,th:string):Promise<void>=>{
      if(sh===th) return;
      const sn=node(await request(a,`/node?path=${p}&revision=${sr.revision}`),p,sr.revision,sh);
      const tn=node(await request(b,`/node?path=${p}&revision=${tr.revision}`),p,tr.revision,th);
      if(p.length===3) {
        const k=KEYS[Number.parseInt(p,2)]!;
        const data=await request(a,`/record?key=${k}&revision=${sr.revision}`);
        if(!exact(data,['revision','key','value','hash'])||data.revision!==sr.revision||data.key!==k||!value(data.value)||!hash(data.hash)||data.hash!==sh||leafHash(k,data.value)!==sh) upstream();
        records.push({key:k,value:data.value});return;
      }
      if(!sn.children||!tn.children) upstream();
      await visit(p+'0',sn.children.left,tn.children.left);
      await visit(p+'1',sn.children.right,tn.children.right);
    };
    await visit('',sr.hash,tr.hash);
    const reply=await request(b,'/apply',{expectedRevision:tr.revision,records});
    // At least one committed leaf differs: a successful apply must advance exactly once.
    if(!exact(reply,['revision'])||!revision(reply.revision)||reply.revision!==tr.revision+1) upstream();
    return {changed:records.map(r=>r.key),sourceRevision:sr.revision,targetRevision:reply.revision};
  } catch(error) {
    if(error instanceof HttpError&&(error.status===409||error.status===429)) throw error;
    return upstream();
  } finally {if(timer) clearTimeout(timer);abort.abort();}
}
export async function main():Promise<void> {
  const [source,target]=origins(process.env.SOURCE_ORIGIN,process.env.TARGET_ORIGIN);
  await serve('merkle-repair',3065,async(req,res)=>{
    const url=new URL(req.url??'/','http://repair');
    if(url.pathname!=='/repair') throw new HttpError(404,'not_found','Route not found');
    if(req.method!=='POST') methodNotAllowed(res,'POST');
    query(url,[]);
    if(!exact(await publicBody(req),[])) invalid();
    json(res,200,await repairSnapshot(source,target));
  });
}
if(import.meta.main) main().catch((error:unknown)=>{console.error(error instanceof Error?error.message:'Startup failed');process.exitCode=1;});
