import { HttpError,json,readJson,serve } from '../../../lib/http.mts';
import { object } from '../tracker.mts';
export async function main() {
  let mode='normal'; let requests=0;
  const target=process.env.TARGET_ORIGIN;
  await serve('fixture',0,async(req,res)=>{
    if(req.url==='/count') {json(res,200,{requests});return;}
    if(req.url==='/mode' && req.method==='POST') {
      const body=await readJson(req);
      if(!object(body,['mode']) || typeof body.mode!=='string' || !['normal','escaped','oversize','invalid','slow','redirect','unavailable'].includes(body.mode)) throw new HttpError(400,'invalid','Invalid mode');
      mode=body.mode;json(res,200,{ok:true});return;
    }
    requests++;
    if(mode==='slow') {res.writeHead(200);res.write('{');setTimeout(()=>res.end('}'),350);return;}
    if(mode==='redirect') {res.writeHead(307,{location:target});res.end();return;}
    if(mode==='unavailable') {json(res,503,{error:{code:'unavailable',message:'Teaching outage'}});return;}
    if(mode==='invalid') {json(res,200,{incarnation:1,sequence:'1'});return;}
    const base=JSON.stringify({incarnation:1,sequence:1});
    // Only JSON string tokens are escaped; numeric tokens remain valid numbers.
    const escaped=base.replace(/"([^"\\]*)"/g,(_token:string,s:string)=>'"'+[...s].map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('')+'"');
    res.writeHead(200,{'content-type':'application/json'});
    res.end(mode==='escaped'?escaped:mode==='oversize'?base+' '.repeat(513):base);
  });
}
if(import.meta.main) await main();
