import { serve,json,readJson } from '../../../lib/http.mts';
import { object } from '../model.mts';
// A reusable independent upstream, configured only by the test runner on loopback.
export async function main() {
  let mode='ok',hits=0,destination='';
  const e={id:'abcdefghijklmnop',payload:'p'.repeat(32),stamp:{wall:1700000000000,counter:0,replica:'a'}};
  return serve('hlc-fixture',0,async(req,res)=>{
    if(req.url==='/hits') return json(res,200,{hits});
    if(req.url==='/mode') {const v=await readJson(req);if(!object(v,['mode','destination'])||typeof v.mode!=='string'||typeof v.destination!=='string') throw new Error('Bad mode');mode=v.mode;destination=v.destination;return json(res,200,{});}
    hits++;
    if(mode==='redirect') {res.writeHead(307,{location:destination});res.end();return;}
    if(mode==='slow') {await new Promise(r=>setTimeout(r,350));return json(res,200,e);}
    if(mode==='delay') await new Promise(r=>setTimeout(r,180));
    if(mode==='body-slow') {res.writeHead(200,{'content-type':'application/json'});res.write('{');await new Promise(r=>setTimeout(r,350));res.end('}');return;}
    if(mode==='bad-clock') return json(res,201,{clock:{wall:1700000000000,counter:'1'}});
    if(mode==='extra-clock') return json(res,201,{clock:{wall:1700000000000,counter:1,extra:0}});
    if(mode.startsWith('absent')) return json(res,404,mode==='absent-null'?null:mode==='absent-array'?[]:mode==='absent-unexpected'?{error:{code:'internal_error',message:'Unexpected service error'}}:mode==='absent-extra'?{error:{code:'rejected',message:'Request rejected'},extra:true}:{error:{code:'rejected',message:'Request rejected'}});
    if(mode.startsWith('unexpected')) return json(res,mode==='unexpected409'?409:mode==='unexpected422'?422:429,{error:{code:'internal_error',message:'Unexpected service error'}});
    if(mode==='bad-error') return json(res,429,{error:{code:1,message:'capacity'}});
    if(mode==='status') return json(res,503,{error:'down'});
    if(mode==='primitive') return json(res,200,false);
    if(mode==='extra') return json(res,200,{...e,extra:true});
    if(mode==='wrong-id') return json(res,200,{...e,id:'different'});
    if(mode==='wrong-replica') return json(res,200,{...e,stamp:{...e.stamp,replica:'b'}});
    if(mode==='malformed') {res.end('{');return;}
    const body=req.url==='/receive'?{clock:{wall:1700000000000,counter:1}}:e;
    if(mode==='reject'||mode==='reject409'||mode==='reject429') return json(res,mode==='reject409'?409:mode==='reject429'?429:422,{error:{code:'rejected',message:'Request rejected'}});
    if(mode==='escaped'||mode==='oversize') {
      // Rewrite STRING tokens only; numbers, booleans and null remain JSON tokens.
      let wire=JSON.stringify(body).replace(/"(?:[^"\\]|\\.)*"/g,token=>{
        const decoded:unknown=JSON.parse(token);if(typeof decoded!=='string') throw new Error('String expected');
        return '"'+Array.from(decoded,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('')+'"';
      });
      if(mode==='oversize') wire=' '.repeat(4097)+wire;
      res.writeHead(req.url==='/receive'?201:200,{'content-type':'application/json'});res.end(wire);return;
    }
    return json(res,req.url==='/receive'?201:200,body);
  });
}
if(import.meta.main) await main();
