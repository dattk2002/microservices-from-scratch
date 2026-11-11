// Independent, bounded fault source. Never imported or used by application code.
import { json, readJson, serve } from '../../../lib/http.mts';
import { fail, object, parseRegister } from '../core.mts';
import type { ServerResponse } from 'node:http';
export async function main() {
  if (process.env.TEACHING_CONTROLS!=='1') throw new Error('Test controls required');
  let mode='valid', calls=0;
  const pending=new Set<ServerResponse>();
  const server=await serve('fixture',0,async(req,res)=>{
    if (req.url==='/control' && req.method==='POST') {
      const b=await readJson(req);
      if (!object(b) || typeof b.mode!=='string' || !['valid','escaped','malformed','oversized','hold','redirect','conflict','wrongEcho','status'].includes(b.mode)) fail(400,'control');
      mode=b.mode; calls=0;
      for (const held of pending) { held.end(JSON.stringify({version:1,value:100})); }
      pending.clear(); json(res,200,{mode}); return;
    }
    if (req.url==='/state' && req.method==='GET') { json(res,200,{calls,pending:pending.size}); return; }
    if (req.url!=='/register' || (req.method!=='GET' && req.method!=='PUT')) fail(404,'route');
    calls++;
    const register=req.method==='PUT' ? parseRegister(await readJson(req)) : {version:1,value:100};
    if (!register) fail(400,'register');
    if (mode==='redirect') { res.writeHead(307,{location:process.env.REDIRECT_ORIGIN+'/register'}); res.end(); return; }
    if (mode==='status') { json(res,503,{error:'unavailable'}); return; }
    if (mode==='hold') {
      if (pending.size>=4) fail(503,'fixture_capacity');
      res.writeHead(200,{'content-type':'application/json'}); res.flushHeaders();
      pending.add(res); res.once('close',()=>pending.delete(res)); return;
    }
    if (mode==='malformed') { json(res,200,{version:'1',value:100}); return; }
    if (mode==='conflict' || mode==='wrongEcho') { json(res,200,{version:1,value:99}); return; }
    if (mode==='oversized') { res.writeHead(200); res.end(' '.repeat(1025)+JSON.stringify(register)); return; }
    if (mode==='escaped') {
      res.writeHead(200); res.end('{"\\u0076ersion":1,"\\u0076alue":100}'); return;
    }
    json(res,200,register);
  });
  return server;
}
if (import.meta.main) await main();
