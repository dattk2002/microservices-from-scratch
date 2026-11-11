import { json, numberSetting, readJson, serve } from '../../lib/http.mts';
import { choose, CommandStore, fail, integer, object, open, parseRegister } from './core.mts';
import type { Register } from './core.mts';
function origin(raw:string|undefined):string {
  if (!raw) throw new Error('Three replica origins required');
  const url=new URL(raw);
  if (url.protocol!=='http:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash) throw new Error('Invalid HTTP origin');
  return url.origin;
}
// A register needs at most 35 ASCII bytes canonically; escaped keys and generous
// whitespace remain legal up to this explicit transport budget.
async function vote(base:string,signal:AbortSignal,register?:Register):Promise<Register|null> {
  try {
    const response=await fetch(`${base}/register`,{method:register?'PUT':'GET',redirect:'error',signal,
      ...(register?{headers:{'content-type':'application/json'},body:JSON.stringify(register)}:{})});
    if (response.status!==200) { await response.body?.cancel(); return null; }
    const reader=response.body?.getReader();
    if (!reader) return null;
    const chunks:Uint8Array[]=[]; let bytes=0;
    try {
      for (;;) {
        const part=await reader.read(); if (part.done) break;
        bytes+=part.value.byteLength;
        if (bytes>1024) { await reader.cancel(); return null; }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    return parseRegister(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
  } catch { return null; }
}
export async function main() {
  const origins=[origin(process.env.REPLICA_A_ORIGIN),origin(process.env.REPLICA_B_ORIGIN),origin(process.env.REPLICA_C_ORIGIN)];
  if (new Set(origins).size!==3) throw new Error('Origins must be distinct');
  const path=process.env.DB_PATH;
  if (!path) throw new Error('DB_PATH required');
  const deadline=numberSetting('OPERATION_MS',800,50,5000);
  const db=open(path), store=new CommandStore(db);
  let active=false;
  async function read(signal:AbortSignal) {
    const results=await Promise.all(origins.map(o=>vote(o,signal)));
    return choose(results.filter((r):r is Register=>r!==null));
  }
  async function put(register:Register,signal:AbortSignal) {
    const results=await Promise.all(origins.map(o=>vote(o,signal,register)));
    return results.filter(r=>r?.version===register.version && r.value===register.value).length;
  }
  const server=await serve('quorum',5150,async(req,res)=>{
    if (req.method==='GET' && req.url==='/state') { json(res,200,{receipts:store.list(),active}); return; }
    if (req.method==='GET' && req.url?.startsWith('/writes/')) {
      const id=req.url.slice(8);
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) fail(400,'invalid_id');
      const r=store.find(id); if (!r) fail(404,'not_found');
      json(res,200,{receipt:r,active}); return;
    }
    if (req.method==='GET' && req.url==='/register') {
      json(res,200,await read(AbortSignal.timeout(deadline))); return;
    }
    if (req.method!=='POST' || (req.url!=='/writes' && req.url!=='/repair')) fail(404,'not_found');
    // Synchronous admission before body parsing: slow clients cannot overlap mutations.
    if (active) fail(409,'busy');
    active=true;
    const signal=AbortSignal.timeout(deadline);
    const bodyTimer=setTimeout(()=>req.destroy(),deadline);
    try {
      const body=await readJson(req);
      clearTimeout(bodyTimer);
      if (signal.aborted) fail(503,'deadline');
      if (req.url==='/repair') {
        if (!object(body) || Object.keys(body).length!==0) fail(400,'invalid_repair');
        const register=await read(signal);
        const acknowledgements=register.version===0 ? 0 : await put(register,signal);
        json(res,200,{register,acknowledgements}); return;
      }
      if (!object(body) || Object.keys(body).length!==2 || typeof body.id!=='string' || !/^[A-Za-z0-9_-]{1,32}$/.test(body.id) || !integer(body.value,1,100)) fail(400,'invalid_write');
      const receipt=store.begin(body.id,body.value);
      if (receipt.state==='acknowledged') { json(res,200,receipt); return; }
      const acknowledgements=await put({version:receipt.version,value:receipt.value},signal);
      if (acknowledgements>=2) store.acknowledge(receipt.id);
      json(res,acknowledgements>=2?200:503,store.find(receipt.id));
    } finally { clearTimeout(bodyTimer); active=false; }
  });
  server.once('close',()=>db.close()); return server;
}
if (import.meta.main) await main();
