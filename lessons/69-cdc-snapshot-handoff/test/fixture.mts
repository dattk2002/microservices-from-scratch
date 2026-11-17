import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { json, serve } from '../../../lib/http.mts';
import { fail, fields } from '../protocol.mts';
import { readBody } from '../runtime.mts';
import { escapedJson } from './wire.mts';

const modes=['normal','primitive','array','extra','bad-last','gap','wrong-after','empty-lag','too-many','low-through',
 'bad-snapshot','unsorted','duplicate','error-known','error-unexpected','error-primitive','error-array','error-fields',
 'error-message','error-404','error-422','error-429','oversize','oversize-error','malformed','wrong-type','drop','redirect','slow-headers','slow-body','slow-total'];

export async function main() {
 let forwarded=0;let mode='normal';let requests=0;const paths:string[]=[];
 const sink=createServer((req,res)=>{
  req.resume();if(req.url==='/health')return json(res,200,{ready:true});
  forwarded++;json(res,200,{received:true});
 });
 try {
  await new Promise<void>((resolve,reject)=>{sink.once('error',reject);sink.listen(0,'127.0.0.1',resolve);});
  const address=sink.address();if(!address||typeof address==='string')throw new Error('Missing sink port');
  const sinkOrigin=`http://127.0.0.1:${address.port}`;
  const boundary={through:2,items:[{key:'k0',value:'old'},{key:'k1',value:'erase'}]};
  const events=[{seq:3,key:'k0',value:'new'},{seq:4,key:'k1',value:null},{seq:5,key:'k2',value:'born'},
   {seq:6,key:'k3',value:'third'},{seq:7,key:'k0',value:'latest'}];
  const later=(res:ServerResponse,delay:number,work:()=>void)=>{
   const timer=setTimeout(()=>{if(!res.destroyed)work();},delay);
   res.once('close',()=>clearTimeout(timer));
  };
  const server=await serve('cdc-adversary',0,async(req,res)=>{
   if(req.method==='GET'&&req.url==='/stats')return json(res,200,{requests,forwarded,sinkOrigin,paths});
   if(req.method==='POST'&&req.url==='/control') {
    const body=fields(await readBody(req),['mode']);
    if(typeof body.mode!=='string'||!modes.includes(body.mode))fail(400,'invalid_body');
    mode=body.mode;return json(res,200,{mode});
   }
   if(req.method!=='GET'||!(req.url==='/snapshot'||req.url?.startsWith('/changes?')))fail(404,'not_found');
   requests++;paths.push(req.url);const route=req.url;
   const after=Number(new URL(route,'http://127.0.0.1').searchParams.get('after')??0);
   const changes=events.filter(event=>event.seq>after).slice(0,4);
   let body:unknown=route==='/snapshot'?boundary:{after,through:7,changes};let status=200;
   if(mode==='primitive')body=true;
   if(mode==='array')body=[];
   if(mode==='extra')body=route==='/snapshot'?{...boundary,extra:0}:{after,through:7,changes,extra:0};
   if(mode==='bad-snapshot')body={through:2,items:[{key:'k0',value:'old'},{key:'k1',value:42}]};
   if(mode==='unsorted')body={through:2,items:[...boundary.items].reverse()};
   if(mode==='duplicate')body={through:2,items:[boundary.items[0],boundary.items[0]]};
   if(mode==='bad-last')body={after,through:7,changes:[...changes.slice(0,-1),{seq:after+changes.length,key:'k3',value:42}]};
   if(mode==='gap')body={after,through:7,changes:changes.slice(1)};
   if(mode==='wrong-after')body={after:after+1,through:7,changes};
   if(mode==='empty-lag')body={after,through:7,changes:[]};
   if(mode==='too-many')body={after,through:7,changes:events};
   if(mode==='low-through')body={after,through:after,changes};
   if(mode.startsWith('error-')||mode==='oversize-error') {
    status=mode==='error-404'?404:mode==='error-422'?422:mode==='error-429'?429:409;
    body={error:{code:'cursor_ahead',message:'Cursor exceeds source highwater'}};
    if(mode==='error-unexpected')body={error:{code:'internal_error',message:'Unexpected service error'}};
    if(mode==='error-primitive')body=0;
    if(mode==='error-array')body={error:[]};
    if(mode==='error-fields')body={error:{code:'cursor_ahead',message:'Cursor exceeds source highwater',extra:true}};
    if(mode==='error-message')body={error:{code:'cursor_ahead',message:'wrong'}};
   }
   if(mode==='redirect') {res.writeHead(307,{location:sinkOrigin+'/capture'});res.end();return;}
   let wire=escapedJson(body);
   if(mode==='oversize'||mode==='oversize-error')wire+=' '.repeat(8193);
   if(mode==='malformed')wire='{';
   res.setHeader('content-type',mode==='wrong-type'?'text/plain':'application/json');res.statusCode=status;
   if(mode==='drop') {res.write(wire.slice(0,Math.max(1,wire.length-1)));res.destroy();return;}
   if(mode==='slow-headers') {later(res,900,()=>res.end(wire));return;}
   if(mode==='slow-body') {res.write(wire.slice(0,-1));later(res,900,()=>res.end(wire.slice(-1)));return;}
   if(mode==='slow-total') {later(res,200,()=>{res.write(wire.slice(0,-1));later(res,400,()=>res.end(wire.slice(-1)));});return;}
   res.end(wire);
  });
  server.once('close',()=>{sink.closeAllConnections();sink.close();});return server;
 } catch(error) {sink.closeAllConnections();sink.close();throw error;}
}
if(import.meta.main)await main();
