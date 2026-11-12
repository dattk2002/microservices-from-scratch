import { performance } from 'node:perf_hooks';
import { serve,json,readJson,HttpError } from '../../lib/http.mts';
import { object,idBody,origin,validReply } from './contracts.mts';
import { Limiter } from './controller.mts';
export async function main(){
  const worker=origin(process.env.WORKER_ORIGIN),teaching=process.env.TEACHING_CONTROLS==='1';
  let logical=0;const now=()=>teaching?logical:performance.now();const limiter=new Limiter();
  return serve('gateway',3059,async(req,res)=>{
    if(req.method==='GET'&&req.url==='/state'){json(res,200,limiter.state());return;}
    if(teaching&&req.method==='POST'&&req.url==='/teaching/advance'){
      const {milliseconds}=object(await readJson(req),['milliseconds']);
      if(typeof milliseconds!=='number'||!Number.isInteger(milliseconds)||milliseconds<1||milliseconds>1000||logical+milliseconds>10000)throw new HttpError(400,'invalid_body','Invalid body');
      logical+=milliseconds;json(res,200,{now:logical});return;
    }
    if(req.method!=='POST'||req.url!=='/work')throw new HttpError(404,'not_found','Unknown route');
    const id=idBody(await readJson(req));
    if(res.destroyed)return;
    const settle=limiter.admit();
    if(!settle){res.setHeader('retry-after','1');json(res,429,{error:{code:'busy',message:'No capacity'}});return;}
    const start=now(),abort=new AbortController();let timedOut=false,cancelled=false;
    const close=()=>{cancelled=true;abort.abort();settle('neutral',0);};
    res.once('close',close);
    const timer=setTimeout(()=>{timedOut=true;abort.abort();},300);
    let response:Awaited<ReturnType<typeof fetch>>|undefined;
    try{
      response=await fetch(worker+'/lookup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id}),redirect:'error',signal:abort.signal});
      const chunks:Uint8Array[]=[];let bytes=0;
      if(!response.body)throw new Error('Missing body');
      for await(const chunk of response.body){bytes+=chunk.length;if(bytes>512)throw new Error('Upstream body too large');chunks.push(chunk);}
      const value:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(!validReply(value,id,response.status))throw new Error('Invalid upstream contract');
      if(cancelled)return;
      settle(response.status===200?'success':response.status===503?'congestion':'neutral',now()-start);
      json(res,response.status===503?502:response.status,value);
    }catch{
      if(cancelled)return;
      settle(timedOut?'congestion':'neutral',now()-start);
      json(res,timedOut?504:502,{error:{code:timedOut?'timeout':'bad_gateway',message:timedOut?'Worker deadline exceeded':'Invalid upstream response'}});
    }finally{
      clearTimeout(timer);res.off('close',close);abort.abort();
      if(response?.body&&!response.body.locked)await response.body.cancel().catch(()=>{});
      settle('neutral',0);
    }
  });
}
if(import.meta.main)await main();
