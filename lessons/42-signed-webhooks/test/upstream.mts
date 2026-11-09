import { serve,json,readJson } from '../../../lib/http.mts';
import { object,fail } from '../core.mts';
import type { ServerResponse } from 'node:http';
async function main() {
 let mode='valid';let calls=0;let targets=0;let held:ServerResponse|undefined;
 await serve('test-upstream',0,async(req,res)=>{
  if(req.url==='/control'&&req.method==='POST') {
   const o=object(await readJson(req));
   if(typeof o.mode!=='string'||!['valid','schema','malformed','oversize','redirect','hold','release'].includes(o.mode)) fail(400,'control');
   if(o.mode==='release') {held?.end();held=undefined;} else {mode=o.mode;calls=0;targets=0;}
   json(res,200,{ok:true});return;
  }
  if(req.url==='/stats') {json(res,200,{calls,targets,held:held!==undefined});return;}
  if(req.url==='/target') {targets++;json(res,200,{id:'a',duplicate:false,total:1});return;}
  if(req.url==='/webhook') {
   const value=object(await readJson(req));calls++;
   if(mode==='hold') {held=res;return;}
   if(mode==='redirect') {res.writeHead(307,{location:new URL('/target',process.env.TARGET_ORIGIN).href});res.end();return;}
   if(mode==='malformed') {res.end('{');return;}
   if(mode==='schema') {json(res,200,{id:value.id,duplicate:'false',total:1});return;}
   if(mode==='oversize') {json(res,200,{id:value.id,duplicate:false,total:1,padding:'x'.repeat(600)});return;}
   json(res,200,{id:value.id,duplicate:false,total:1});return;
  }
  fail(404,'not_found');
 });
}
if(import.meta.main) await main();
