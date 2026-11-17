import type { ServerResponse } from 'node:http';
import { json, readJson, serve } from '../../../lib/http.mts';
import { ALGORITHM, exact, fail, normalizeOrigin, replyError } from '../protocol.mts';

const modes = ['ok','null','array','primitive','extra','wrong-id','wrong-algorithm','short','long','negative','high','fraction','string-rank','object-registers','error','error-primitive','error-array','error-extra','wrong-code','status201','status404','status409','status422','status429','status503','media','utf8','malformed','oversize','chunked-oversize','escaped','slow-headers','slow-body','slow-parts','redirect','close'];

function schedule(res: ServerResponse, delay: number, action: () => void): void {
  const timer = setTimeout(() => { if (!res.destroyed && !res.writableEnded) action(); }, delay);
  res.once('close', () => clearTimeout(timer));
}
function escapedJson(value: unknown): string {
  // Escape decoded string tokens only; JSON numbers, true/false/null remain untouched.
  return JSON.stringify(value).replace(/"(?:[^"\\]|\\.)*"/g, token => {
    const decoded: unknown = JSON.parse(token);
    if (typeof decoded !== 'string') throw new Error('Expected string token');
    return '"' + Array.from(decoded, char => '\\u'+char.charCodeAt(0).toString(16).padStart(4,'0')).join('') + '"';
  });
}
export async function main(): Promise<void> {
  const id = process.env.FIXTURE_ID;
  if (id !== 'a' && id !== 'b' && id !== 'sink') throw new Error('Invalid FIXTURE_ID');
  const redirect = id === 'sink' ? '' : normalizeOrigin(process.env.REDIRECT_ORIGIN ?? '');
  let mode = 'ok', received = 0;
  await serve('hll-fixture', 0, async (req, res) => {
    try {
      if (req.url === '/stats' && req.method === 'GET') { json(res,200,{received}); return; }
      if (id === 'sink') { received++; json(res,200,{}); return; }
      if (req.url === '/mode' && req.method === 'POST') {
        const body = await readJson(req);
        if (!exact(body,['mode']) || typeof body.mode !== 'string' || !modes.includes(body.mode)) fail(400,'invalid_request');
        mode = body.mode; json(res,200,{mode}); return;
      }
      if (req.url !== '/snapshot' || req.method !== 'GET') fail(404,'not_found');
      const good = {id,algorithm:ALGORITHM,registers:Array<number>(16).fill(0)};
      let body: unknown = good;
      let status = 200;
      switch (mode) {
        case 'null': body = null; break;
        case 'array': body = []; break;
        case 'primitive': body = true; break;
        case 'extra': body = {...good,extra:true}; break;
        case 'wrong-id': body = {...good,id:id==='a'?'b':'a'}; break;
        case 'wrong-algorithm': body = {...good,algorithm:'hll++'}; break;
        case 'short': body = {...good,registers:good.registers.slice(1)}; break;
        case 'long': body = {...good,registers:[...good.registers,0]}; break;
        case 'negative': body = {...good,registers:[-1,...good.registers.slice(1)]}; break;
        case 'high': body = {...good,registers:[30,...good.registers.slice(1)]}; break;
        case 'fraction': body = {...good,registers:[0.5,...good.registers.slice(1)]}; break;
        case 'string-rank': body = {...good,registers:['0',...good.registers.slice(1)]}; break;
        case 'object-registers': body = {...good,registers:{toString:null}}; break;
        case 'error': body = {error:{code:'internal_error',message:'internal_error'}}; break;
        case 'error-primitive': body = {error:1}; break;
        case 'error-array': body = {error:[]}; break;
        case 'error-extra': body = {error:{code:'internal_error',message:'internal_error',extra:1}}; break;
        case 'wrong-code': status = 404; body = {error:{code:'internal_error',message:'internal_error'}}; break;
      }
      if (mode.startsWith('status')) { status = Number(mode.slice(6)); body = good; }
      if (mode === 'redirect') { res.writeHead(307,{location:redirect+'/payload'}); res.end(); return; }
      if (mode === 'close') { req.socket.destroy(); return; }
      const wire = mode === 'escaped' ? escapedJson(body) : JSON.stringify(body);
      if (mode === 'slow-headers') { schedule(res,700,() => json(res,200,good)); return; }
      res.writeHead(status, {'content-type':mode==='media'?'text/plain':'application/json'});
      if (mode === 'slow-body' || mode === 'slow-parts') {
        res.write(wire.slice(0,1));
        if (mode === 'slow-body') schedule(res,700,() => res.end(wire.slice(1)));
        else {
          const split = Math.floor(wire.length/2);
          schedule(res,280,() => { res.write(wire.slice(1,split)); });
          schedule(res,560,() => res.end(wire.slice(split)));
        }
      } else if (mode === 'oversize') res.end(wire+' '.repeat(8192));
      else if (mode === 'chunked-oversize') { res.write(wire); schedule(res,10,() => res.end(' '.repeat(8192))); }
      else if (mode === 'utf8') res.end(Buffer.from([0xff]));
      else if (mode === 'malformed') res.end('{');
      else res.end(wire);
    } catch (error) { replyError(res,error); }
  });
}
if (import.meta.main) main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Startup failed'); process.exitCode = 1;
});
