// Test-only process: one reusable source, also a reachable redirect destination.
import { json,readJson,serve } from '../../../lib/http.mts';
import { idsFrom,record,failure } from '../batcher.mts';
function escaped(value:unknown):string{
 const text=JSON.stringify(value);
 return text.replace(/"(?:[^"\\]|\\.)*"/g,token=>{
  const decoded:unknown=JSON.parse(token);if(typeof decoded!=='string')throw Error('string token');
  return '"'+[...decoded].map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('')+'"';
 });
}
export async function main(){
 let mode='normal',target='',hits=0,calls=0;const timers=new Set<ReturnType<typeof setInterval>>();
 const allowed=['normal','missing','extra','duplicate','falseValue','badBoolean','range','fraction','oversize','slow','redirect','escaped'];
 const server=await serve('batch-fixture',0,async(req,res)=>{
  if(req.url==='/state'){json(res,200,{hits,calls});return;}
  if(req.url==='/configure'){
   const v=await readJson(req);if(!record(v)||typeof v.mode!=='string'||!allowed.includes(v.mode)||typeof v.target!=='string')throw failure(400);
   mode=v.mode;target=v.target;calls=0;json(res,200,{});return;
  }
  if(req.url==='/sink'){hits++;await readJson(req);json(res,200,{});return;}
  if(req.url!=='/batch'){json(res,404,{});return;}
  const ids=idsFrom(await readJson(req),4,true);calls++;
  const items:Record<string,unknown>[]=ids.slice().reverse().map(id=>({id,found:true,value:10}));
  if(mode==='missing')items.pop();
  if(mode==='extra')items.push({id:'extra',found:false});
  if(mode==='duplicate'&&items[0])items[items.length-1]={...items[0]};
  if(mode==='falseValue'&&items[0])items[0]={id:items[0].id,found:false,value:10};
  if(mode==='badBoolean'&&items[0])items[0].found='true';
  if(mode==='range'&&items[0])items[0].value=101;
  if(mode==='fraction'&&items[0])items[0].value=1.5;
  if(mode==='redirect'){res.writeHead(307,{location:target});res.end();return;}
  let body=mode==='escaped'?escaped({items}):JSON.stringify({items});
  // Legal insignificant JSON whitespace: only the byte gate makes this invalid.
  if(mode==='oversize')body+=' '.repeat(2100);
  res.writeHead(200,{'content-type':'application/json'});
  if(mode==='slow'){
   res.write(' ');let chunks=0;
   const timer=setInterval(()=>{
    chunks++;if(chunks===15){clearInterval(timer);timers.delete(timer);res.end(body);}else res.write(' ');
   },30);timers.add(timer);
   res.once('close',()=>{clearInterval(timer);timers.delete(timer);});return;
  }
  res.end(body);
 });
 const cleanup=()=>{for(const timer of timers)clearInterval(timer);timers.clear();};
 server.once('close',cleanup);process.once('SIGTERM',cleanup);process.once('SIGINT',cleanup);
}
if(import.meta.main)await main();
