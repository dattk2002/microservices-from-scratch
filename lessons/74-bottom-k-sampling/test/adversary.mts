import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import { json, readJson } from '../../../lib/http.mts';
import { algorithm, bottom4, exact, snapshotValid } from '../contracts.mts';
import type { SampleId } from '../contracts.mts';

// One fixture process owns two upstream origins and a distinct, reachable redirect destination.
export async function main(): Promise<void> {
  const servers: Server[]=[];
  const timers=new Set<ReturnType<typeof setTimeout>>();
  const modes={a:'valid',b:'valid'};
  let count=0;
  let destination='';
  let bOrigin='';
  const close=()=>{
    for (const timer of timers) clearTimeout(timer);
    for (const server of servers) { server.close(); server.closeAllConnections(); }
  };
  const later=(res: ServerResponse, action: ()=>void,delay=700)=>{
    const timer=setTimeout(()=>{timers.delete(timer);if (!res.destroyed) action();},delay);
    timers.add(timer);
    res.once('close',()=>{clearTimeout(timer);timers.delete(timer);});
  };
  async function acquire(server: Server): Promise<string> {
    // Register ownership before listen can throw; outer catch cleans every startup failure.
    servers.push(server);
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const address=server.address();
    if (!address || typeof address === 'string') throw new Error('No fixture port');
    return `http://127.0.0.1:${address.port}`;
  }
  function upstream(id: SampleId): Server {
    return createServer((req,res)=>{
      void (async ()=>{
        if (req.url === '/origins') { json(res,200,{b:bOrigin,destination}); return; }
        if (req.url === '/counter') { json(res,200,{count}); return; }
        if (req.url === '/control') {
          const body=await readJson(req);
          if (!exact(body,['side','mode']) || (body.side !== 'a' && body.side !== 'b') || typeof body.mode !== 'string') {
            json(res,400,{error:{code:'invalid_request',message:'invalid_request'}}); return;
          }
          modes[body.side]=body.mode;
          json(res,200,{mode:body.mode}); return;
        }
        if (req.url !== '/snapshot') { json(res,404,{}); return; }
        const mode=modes[id];
        const value={id,algorithm,sample:bottom4(['a','b','c','d','e','f','g','h','i','j','k','l'])};
        if (mode === 'redirect') { res.writeHead(307,{location:destination+'/captured'});res.end();return; }
        if (mode === 'disconnect') { req.socket.destroy(); return; }
        if (mode === 'headersdelay') { later(res,()=>json(res,200,value)); return; }
        if (mode === 'bodydelay' || mode === 'combineddelay') {
          const write=()=>{
            res.writeHead(200,{'content-type':'application/json'});res.write('{"id":');
            later(res,()=>res.end(JSON.stringify(id)+',"algorithm":"bottom4-sha256-v1","sample":[]}'),mode === 'combineddelay'?350:700);
          };
          if (mode === 'combineddelay') later(res,write,300); else write();
          return;
        }
        if (mode === 'null') { json(res,200,null);return; }
        if (mode === 'array') { json(res,200,[]);return; }
        if (mode === 'primitive') { json(res,200,42);return; }
        if (mode === 'extra') { json(res,200,{...value,extra:1});return; }
        if (mode === 'identity') { json(res,200,{...value,id:id === 'a'?'b':'a'});return; }
        if (mode === 'algorithm') { json(res,200,{...value,algorithm:'other'});return; }
        if (mode === 'sort') { json(res,200,{...value,sample:value.sample.toReversed()});return; }
        if (mode === 'duplicate') { json(res,200,{...value,sample:[value.sample[0],value.sample[0]]});return; }
        if (mode === 'hash') { json(res,200,{...value,sample:[{id:'j',priority:'0'.repeat(64)}]});return; }
        if (mode === 'entryextra') { json(res,200,{...value,sample:[{...value.sample[0],extra:1}]});return; }
        if (mode === 'five') { json(res,200,{...value,sample:[...value.sample,bottom4(['a'])[0]]});return; }
        if (mode === 'type') { res.writeHead(200,{'content-type':'text/plain'});res.end(JSON.stringify(value));return; }
        if (mode === 'malformed') { res.writeHead(200,{'content-type':'application/json'});res.end('{');return; }
        if (mode === 'oversize' || mode === 'boundary') {
          const raw=JSON.stringify(value);
          const wire=raw+' '.repeat((mode === 'oversize'?8193:8192)-Buffer.byteLength(raw));
          if (!snapshotValid(JSON.parse(wire),id)) throw new Error('Fixture must remain schema-valid');
          res.writeHead(200,{'content-type':'application/json'});res.end(wire);return;
        }
        if (/^status(404|409|422|429|500)$/.test(mode)) {
          json(res,Number(mode.slice(6)),{error:{code:'internal_error',message:'internal_error'}});return;
        }
        if (mode === 'valid409' || mode === 'valid500') { json(res,Number(mode.slice(5)),value);return; }
        if (mode === 'short') { json(res,200,{...value,sample:bottom4(['a'])});return; }
        if (mode === 'empty') { json(res,200,{...value,sample:[]});return; }
        json(res,200,value);
      })().catch(()=>{if (!res.destroyed && !res.writableEnded) json(res,500,{error:{code:'fixture_error',message:'fixture_error'}});});
    });
  }
  try {
    destination=await acquire(createServer((req,res)=>{count++;req.resume();json(res,200,{received:true});}));
    bOrigin=await acquire(upstream('b'));
    const source=await acquire(upstream('a'));
    process.once('SIGTERM',close);process.once('SIGINT',close);
    console.log(JSON.stringify({port:Number(new URL(source).port)}));
  } catch (error) { close();throw error; }
}
if (import.meta.main) await main();
