// Independent-process fault fixture. Never imported by service entrypoints.
import type { ServerResponse } from 'node:http';
import { HttpError, json, readJson, serve } from '../../../lib/http.mts';
import { empty } from '../settings.mts';
import { identity, integer, record } from '../store.mts';
async function main():Promise<void>{
  let mode='ok',target='',started=0;
  const held=new Set<ServerResponse>();
  await serve('ack-fixture',0,async(req,res)=>{
    const path=new URL(req.url??'/','http://local').pathname;
    if(req.method==='GET'&&path==='/state'){json(res,200,{started,held:held.size});return;}
    if(req.method==='POST'&&path==='/control'){
      const b=record(await readJson(req));
      if(typeof b.mode!=='string'||!['ok','invalid','wrong-id','wrong-total','null','oversized','slow','redirect','hold','escaped'].includes(b.mode)||typeof b.target!=='string')throw new HttpError(400,'invalid_control','Invalid fixture control');
      const url=new URL(b.target);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')throw new HttpError(400,'invalid_target','Loopback only');
      if(held.size)throw new HttpError(409,'held','Release first');
      mode=b.mode;target=url.origin;started=0;json(res,200,{mode});return;
    }
    if(req.method==='POST'&&path==='/release'){
      empty(await readJson(req));for(const response of held){response.end();}held.clear();json(res,200,{});return;
    }
    if(req.method==='POST'&&path==='/fire'){
      const b=record(await readJson(req)),id=identity(b.id),value=integer(b.value,1,100);started++;
      const ack=JSON.stringify({id,duplicate:false,total:value});
      if(mode==='redirect'){res.writeHead(307,{location:target+'/fire'});res.end();return;}
      if(mode==='escaped'){res.writeHead(200,{'content-type':'application/json'});res.end('{"id":"'+[...id].map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('')+'","duplicate":false,"total":'+value+'}');return;}
      if(mode==='wrong-id'){json(res,200,{id:'different',duplicate:false,total:value});return;}
      if(mode==='wrong-total'){json(res,200,{id,duplicate:false,total:'1'});return;}
      if(mode==='null'){json(res,200,null);return;}
      if(mode==='invalid'){json(res,200,{id,duplicate:'false',total:value});return;}
      if(mode==='oversized'){res.writeHead(200,{'content-type':'application/json'});res.end(ack+' '.repeat(1025));return;}
      if(mode==='hold'||mode==='slow'){
        res.writeHead(200,{'content-type':'application/json'});
        // Full valid JSON followed by unfinished whitespace tests the deadline
        // during body consumption, rather than only connection establishment.
        res.write(ack);held.add(res);res.once('close',()=>held.delete(res));return;
      }
      res.writeHead(200,{'content-type':'application/json'});res.end(ack);return;
    }
    throw new HttpError(404,'not_found','Unknown route');
  });
}
if(import.meta.main)await main();
