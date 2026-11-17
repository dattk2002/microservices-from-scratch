import { HttpError, json, readJson, serve, methodNotAllowed, numberSetting } from '../../lib/http.mts';
import { input, origin, replyValid } from './contracts.mts';

export async function forward(upstream: string, path: string, body: ReturnType<typeof input>): Promise<{status: number; body: unknown}> {
  // The same signal covers headers AND all streamed body bytes; there is no retry.
  const signal=AbortSignal.timeout(500);
  try {
    const response=await fetch(upstream+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal});
    if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      await response.body?.cancel(); throw new Error('Invalid content type');
    }
    if (!response.body) throw new Error('Missing body');
    const reader=response.body.getReader();
    const chunks: Uint8Array[]=[]; let size=0;
    try {
      while (true) {
        const part=await reader.read();
        if (part.done) break;
        size+=part.value.byteLength;
        if (size>8192) throw new Error('Upstream JSON too large');
        chunks.push(part.value);
      }
    } catch (error) { await reader.cancel().catch(()=>{}); throw error; }
    finally { reader.releaseLock(); }
    signal.throwIfAborted();
    const value: unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!replyValid(path,body,response.status,value)) throw new Error('Invalid reply');
    return {status:response.status,body:value};
  } catch { throw new HttpError(502,'upstream_failure','Join reply unavailable or invalid'); }
}
export async function main(): Promise<void> {
  const upstream=origin(process.env.JOIN_ORIGIN);
  if ((process.env.HOST ?? '127.0.0.1') !== '127.0.0.1') throw new Error('HOST must be 127.0.0.1');
  const port=numberSetting('PORT',7071,0,65535);
  if (port !== 0 && upstream === new URL(`http://127.0.0.1:${port}`).origin) throw new Error('Origins must be distinct');
  await serve('interval-ingress',7071,async (req,res)=>{
    if (req.url !== '/events' && req.url !== '/watermark') throw new HttpError(404,'not_found','Route not found');
    if (req.method !== 'POST') methodNotAllowed(res,'POST');
    const body=input(req.url,await readJson(req));
    const reply=await forward(upstream,req.url,body);
    json(res,reply.status,reply.body);
  });
}
if (import.meta.main) await main();
