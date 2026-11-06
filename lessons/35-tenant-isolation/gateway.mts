import { createPrivateKey } from 'node:crypto';
import { HttpError } from '../../lib/http.mts';
import { signContext,parseWrite,object,document } from './model.mts';
import { serve,json,readJson,route,boundedReply } from './runtime.mts';
export async function main() {
 const key=createPrivateKey(process.env.PRIVATE_KEY_PEM??'');
 if(key.asymmetricKeyType!=='ed25519') throw Error('Ed25519 required');
 const upstream=new URL(process.env.DOCUMENT_ORIGIN??'http://127.0.0.1:3531');
 if(upstream.protocol!=='http:'||upstream.username||upstream.password||upstream.pathname!=='/'||upstream.search||upstream.hash) throw Error('Expected fixed HTTP origin');
 const teaching=process.env.TEACHING_CONTROLS==='1';
 return serve('tenant-gateway',3530,async(req,res)=>{
  const {id}=route(req);
  const principal=req.headers['x-demo-principal'];
  if(!teaching || (principal!=='alice'&&principal!=='bob')) throw new HttpError(401,'simulated_identity_required','Demo selector disabled or unknown');
  const tenant=principal==='alice'?'red':'blue';
  if(req.method!=='GET'&&!(req.method==='POST'&&id)) throw new HttpError(405,'method_not_allowed','Use GET or POST document');
  const body=req.method==='POST'?parseWrite(await readJson(req)):undefined;
  const token=signContext({iss:'demo-gateway',aud:'documents',sub:principal,tenant,exp:Math.floor(Date.now()/1000)+30},key);
  try {
   const response=await fetch(new URL(id?`/documents/${id}`:'/documents',upstream),{
    method:req.method,headers:{'x-tenant-context':token,'content-type':'application/json'},
    body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(2000),
   });
   const value=await boundedReply(response);
   if(response.status===200) {
    const valid=req.method==='POST'? object(value)&&document(value.document)&&typeof value.replay==='boolean'
     : id?document(value):object(value)&&Array.isArray(value.documents)&&value.documents.length<=20&&value.documents.every(document);
    if(!valid) throw Error('Invalid upstream reply');
   } else if(![400,401,404,409,413,415].includes(response.status)||!object(value)||!object(value.error)||typeof value.error.code!=='string'||typeof value.error.message!=='string') throw Error('Invalid upstream error');
   json(res,response.status,value);
  } catch {throw new HttpError(502,'upstream_failure','Document service unavailable or invalid reply');}
 });
}
if(import.meta.main) await main();
