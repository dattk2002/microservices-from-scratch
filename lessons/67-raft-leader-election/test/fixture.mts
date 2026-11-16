// Test-only, explicitly controlled upstream; it performs no background requests.
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { json, readJson, serve } from '../../../lib/http.mts';
import { Replica } from '../core.mts';
import { exact, fail } from '../protocol.mts';
const modes=['normal','deny','higher','wrong_id','wrong_term','wrong_boolean','extra','null','array','primitive',
  'malformed','escaped','oversize','redirect','drop','slow_body','hold','known_error','unexpected_error',
  'error_null','error_array','error_primitive','error_wrong_message','error_extra','bad_media'];
export function escaped(value:unknown):string {
  return JSON.stringify(value).replace(/"(?:[^"\\]|\\.)*"/g,token=>{
    const value:unknown=JSON.parse(token);
    if(typeof value!=='string')throw new Error('Expected a string token');
    return '"'+Array.from(value,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('')+'"';
  });
}
export async function main() {
  let received=0,calls=0,mode='normal';
  const waiting=new Set<()=>void>();
  const {DatabaseSync}=await import('node:sqlite');
  const db=new DatabaseSync(':memory:');
  try {
    const replica=new Replica(db,'b',0,0);
    // A reachable distinct origin detects an accidental redirected POST, including
    // its payload. Counters never reset on a mode change.
    const sink=createServer(async(req,res)=>{
      received++;
      for await(const _chunk of req) { /* consume without retaining election data */ }
      json(res,200,{id:'b',term:1,granted:true});
    });
    try {
      await new Promise<void>((resolve,reject)=>{
        sink.once('error',reject);sink.listen(0,'127.0.0.1',resolve);
      });
      const address=sink.address();
      if(!address || typeof address==='string')throw new Error('Missing sink address');
      const redirectOrigin=`http://127.0.0.1:${address.port}`;
      const server=await serve('raft-adversarial-peer',0,async(req,res)=>{
        if(req.method==='GET' && req.url==='/stats')return json(res,200,{calls,received,waiting:waiting.size,redirectOrigin});
        if(req.method==='GET' && req.url==='/state')return json(res,200,replica.state());
        if(req.method==='POST' && req.url==='/mode') {
          const body=await readJson(req);
          if(!exact(body,['mode']) || typeof body.mode!=='string' || !modes.includes(body.mode))fail(400,'invalid_body');
          mode=body.mode;return json(res,200,{ok:true});
        }
        if(req.method==='POST' && req.url==='/release') {
          if(!exact(await readJson(req),[]))fail(400,'invalid_body');
          for(const release of waiting)release();
          return json(res,200,{ok:true});
        }
        if(req.method!=='POST' || req.url!=='/vote')fail(404,'not_found');
        const reply=replica.vote(await readJson(req));
        calls++;
        const current=mode;
        if(current==='redirect'){res.writeHead(307,{location:redirectOrigin+'/vote'});res.end();return;}
        if(current==='drop'){res.destroy();return;}
        const abort=new AbortController();
        const onClose=()=>abort.abort();
        res.once('close',onClose);
        try {
          if(current==='hold')await new Promise<void>(resolve=>{
            const release=()=>{waiting.delete(release);resolve();};
            waiting.add(release);res.once('close',release);
          });
          if(current==='slow_body') {
            await delay(200,undefined,{signal:abort.signal});
            res.writeHead(200,{'content-type':'application/json'});res.flushHeaders();
            res.write('{');
            await delay(400,undefined,{signal:abort.signal});
            res.end(JSON.stringify(reply).slice(1));return;
          }
          let value:unknown=reply;
          if(current==='deny')value={...reply,granted:false};
          if(current==='higher')value={id:'b',term:16,granted:false};
          if(current==='wrong_id')value={...reply,id:'a'};
          if(current==='wrong_term')value={...reply,term:17};
          if(current==='wrong_boolean')value={...reply,granted:'true'};
          if(current==='extra')value={...reply,extra:true};
          if(current==='null')value=null;
          if(current==='array')value=[];
          if(current==='primitive')value=true;
          let status=200;
          if(current==='known_error'){status=400;value={error:{code:'invalid_body',message:'invalid_body'}};}
          if(current==='unexpected_error'){status=400;value={error:{code:'internal_error',message:'Unexpected service error'}};}
          if(current==='error_null'){status=400;value=null;}
          if(current==='error_array'){status=400;value=[];}
          if(current==='error_primitive'){status=400;value='invalid_body';}
          if(current==='error_wrong_message'){status=400;value={error:{code:'invalid_body',message:'no'}};}
          if(current==='error_extra'){status=400;value={error:{code:'invalid_body',message:'invalid_body',term:16}};}
          res.writeHead(status,{'content-type':current==='bad_media'?'text/plain':'application/json'});
          if(current==='malformed')res.end('{');
          else if(current==='oversize')res.end(' '.repeat(8193)+escaped(reply));
          else if(current==='escaped')res.end(escaped(value));
          else res.end(JSON.stringify(value));
        } catch(error) {
          if(!abort.signal.aborted)throw error;
        } finally {res.off('close',onClose);}
      });
      server.once('close',()=>{
        for(const release of waiting)release();
        sink.closeAllConnections();sink.close();db.close();
      });
      return server;
    } catch(error) {sink.closeAllConnections();sink.close();throw error;}
  } catch(error) {db.close();throw error;}
}
if(import.meta.main)await main();
