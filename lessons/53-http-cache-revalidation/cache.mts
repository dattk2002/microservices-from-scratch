import {serve,json} from '../../lib/http.mts';
import {Cache,language} from './model.mts';
import {clock,bad,send} from './runtime.mts';
export async function main(){
  const time=clock();const origin=new URL(process.env.ORIGIN_URL??'http://127.0.0.1:3053');
  if(origin.protocol!=='http:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw new Error('ORIGIN_URL must be an HTTP origin');
  const cache=new Cache(time.now,(lang,etag)=>fetch(new URL('/document',origin),{redirect:'error',signal:AbortSignal.timeout(1000),headers:{'accept-language':lang,...(etag?{'if-none-match':etag}:{})}}));
  return serve('http-cache',3054,async(req,res)=>{
    if(await time.route(req,res))return;
    if(req.url==='/state'&&req.method==='GET'){json(res,200,cache.state());return;}
    if(req.url!=='/document'||req.method!=='GET'){json(res,404,{error:'not_found'});return;}
    if(req.headers.authorization!==undefined||req.headers.cookie!==undefined)throw bad();
    let lang;try{lang=language(req.headers['accept-language']);}catch{throw bad();}
    try{const v=await cache.get(lang);send(res,200,v.body,{etag:v.etag,vary:'Accept-Language',date:v.date,age:String(v.age),'cache-control':v.policy,'x-cache':v.kind});}
    catch{json(res,502,{error:'upstream_invalid_or_unavailable'});}
  });
}
if(import.meta.main)await main();
