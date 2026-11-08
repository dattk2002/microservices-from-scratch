import type { IncomingMessage } from 'node:http';
import { HttpError } from '../../lib/http.mts';
// 16 * (256*6 value + 64 ASCII id + 32 structure) + version/envelope < 27000.
export const SNAPSHOT_BYTES=27000;
export const WRITE_BYTES=1600;
export async function body(req:IncomingMessage,limit:number):Promise<unknown> {
 if(req.headers['content-type']?.split(';')[0]!=='application/json')throw new HttpError(415,'media','Use JSON');
 let size=0;const chunks:Buffer[]=[];
 for await(const chunk of req){const b=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=b.length;if(size>limit)throw new HttpError(413,'size','Body too large');chunks.push(b);}
 try{return JSON.parse(Buffer.concat(chunks).toString()) as unknown;}catch{throw new HttpError(400,'json','Invalid JSON');}
}
export function origin(name:string):string {const u=new URL(process.env[name]??'http://127.0.0.1:1');if(u.protocol!=='http:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error(`Invalid ${name}`);return u.origin;}
export async function upstream(url:string,signal:AbortSignal,bodyValue?:unknown):Promise<{status:number;body:unknown}> {
 const r=await fetch(url,{redirect:'error',signal,...(bodyValue===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(bodyValue)})});
 if(!r.body)throw Error('Empty reply');const reader=r.body.getReader();let size=0;const chunks:Uint8Array[]=[];
 try {while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>SNAPSHOT_BYTES)throw Error('Large reply');chunks.push(part.value);}return {status:r.status,body:JSON.parse(Buffer.concat(chunks).toString()) as unknown};}finally{await reader.cancel();}
}
