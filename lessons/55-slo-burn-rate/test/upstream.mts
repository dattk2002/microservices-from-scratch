// Independent test-only HTTP fixture; no production teaching controls.
import { json,readJson,serve,HttpError } from '../../../lib/http.mts';
import { object } from '../model.mts';
export async function main() {
  let body='{"buckets":[]}',status=200,location='',mode='normal',requests=0;
  const held=new Set<import('node:http').ServerResponse>();
  const server=await serve('test-upstream',0,async(req,res)=>{
    if(req.url==='/control'&&req.method==='POST') {
      let v;
      try {v=object(await readJson(req));} catch {throw new HttpError(400,'invalid','object required');}
      if(typeof v.body!=='string'||Buffer.byteLength(v.body)>10000||typeof v.status!=='number'||![200,302,503].includes(v.status)||typeof v.location!=='string'||typeof v.mode!=='string'||!['normal','headers','body','broken'].includes(v.mode)) throw new HttpError(400,'invalid','Invalid fixture');
      body=v.body;status=v.status;location=v.location;mode=v.mode;requests=0;
      for(const old of held) old.destroy();held.clear();
      json(res,200,{ok:true});return;
    }
    if(req.url==='/count') {json(res,200,{requests});return;}
    requests++;
    if(mode==='broken') {res.destroy();return;}
    if(mode==='headers') {held.add(res);res.once('close',()=>held.delete(res));return;}
    res.writeHead(status,{'content-type':'application/json',...(location?{location}: {})});
    if(mode==='body') {res.write(' ');held.add(res);res.once('close',()=>held.delete(res));return;}
    res.end(body);
  });
  server.once('close',()=>{for(const res of held) res.destroy();});
}
if(import.meta.main) await main();
