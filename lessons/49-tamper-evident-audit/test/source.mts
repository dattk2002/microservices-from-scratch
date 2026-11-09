// Test-only independent source: a single bounded fixture reused across failure variants.
import {serve,json,readJson} from '../../../lib/http.mts';
import {object,keys,fail,ZERO,digest} from '../model.mts';
import type {Entry} from '../model.mts';
import type {ServerResponse} from 'node:http';
function exported(count:number){const entries:Entry[]=[];let prev=ZERO;for(let i=0;i<count;i++){const p={id:`_${i}`.padEnd(32,'_'),action:'cancelled' as const,subject:'-'.repeat(32)};const e={seq:i+1,prev,...p,hash:digest(i+1,prev,p.id,p.action,p.subject)};entries.push(e);prev=e.hash;}return {entries,head:{count,hash:prev}};}
export async function main(){
 let mode='valid',count=2,calls=0,leaks=0,target='';let held:{res:ServerResponse;body:unknown}|undefined;
 const server=await serve('audit-test-source',0,async(req,res)=>{
 if(req.method==='GET'&&req.url==='/state'){json(res,200,{calls,leaks,held:!!held});return;}
 if(req.method==='POST'&&req.url==='/control'){
 const o=object(await readJson(req));keys(o,['mode','count','target']);if(typeof o.mode!=='string'||!['valid','invalid','oversize','slow','redirect','hold','escaped'].includes(o.mode)||typeof o.count!=='number'||!Number.isInteger(o.count)||o.count<0||o.count>16)fail(400,'invalid_control');
 if(typeof o.target!=='string')fail(400,'invalid_target');let url:URL;try{url=new URL(o.target);}catch{fail(400,'invalid_target');}if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/'||url.username||url.password||url.search||url.hash)fail(400,'invalid_target');target=url.origin;
 mode=o.mode;count=o.count;calls=0;leaks=0;json(res,200,{});return;
 }
 if(req.method==='POST'&&req.url==='/release'){keys(object(await readJson(req)),[]);if(!held)fail(409,'not_held');json(held.res,200,held.body);held=undefined;json(res,200,{});return;}
 if(req.url==='/leak'){leaks++;json(res,200,exported(count));return;}
 if(req.method==='GET'&&req.url==='/export'){
 calls++;const body=exported(count);
 if(mode==='hold'){if(held)fail(409,'already_held');held={res,body};res.once('close',()=>{if(held?.res===res)held=undefined;});return;}
 if(mode==='redirect'){res.writeHead(302,{location:target+'/leak'});res.end();return;}
 if(mode==='slow'){res.writeHead(200,{'content-type':'application/json'});res.write('{');return;}
 if(mode==='invalid'){body.head.hash=ZERO;json(res,200,body);return;}
 if(mode==='oversize'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(body)+' '.repeat(32769));return;}
 if(mode==='escaped'){
 // Escape decoded string tokens only: seq/count must remain JSON numbers.
 const encoded=JSON.stringify(body).replace(/"(?:[^"\\]|\\.)*"/g,token=>{
 const text:unknown=JSON.parse(token);if(typeof text!=='string')throw new Error('Expected string token');
 return '"'+text.split('').map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('')+'"';
 });
 res.writeHead(200,{'content-type':'application/json'});res.end(encoded);return;
 }
 json(res,200,body);return;
 }fail(404,'not_found');
 });return server;
}
if(import.meta.main)await main();
