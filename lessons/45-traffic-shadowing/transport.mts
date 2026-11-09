import type { IncomingMessage } from 'node:http';
import { HttpError } from '../../lib/http.mts';
export function origin(name:string):string {
  const url = new URL(process.env[name] ?? '');
  if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error(`Invalid ${name}`);
  return url.origin;
}
export async function boundedJson(stream:AsyncIterable<Uint8Array>, limit:number):Promise<unknown> {
  let size=0; const chunks:Uint8Array[]=[];
  for await (const chunk of stream) { size+=chunk.length; if(size>limit) throw new Error('Byte budget'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
export async function control(req:IncomingMessage):Promise<unknown> {
  const timer=setTimeout(()=>req.destroy(),500); timer.unref();
  try { return await boundedJson(req,256); }
  catch { throw new HttpError(400,'invalid_body','Expected bounded JSON object'); }
  finally { clearTimeout(timer); }
}
export async function read(origin:string,id:string,signal:AbortSignal):Promise<unknown> {
  const response=await fetch(`${origin}/products/${id}`, {redirect:'error',headers:{accept:'application/json'},signal});
  try {
    if(response.status!==200 || response.headers.get('content-type')?.split(';')[0] !== 'application/json' || !response.body) throw new Error('Upstream contract');
    // 32 ASCII characters may each occupy six bytes when JSON escaped; 512 covers all legal fields.
    return await boundedJson(response.body,512);
  } finally { await response.body?.cancel().catch(()=>{}); }
}
