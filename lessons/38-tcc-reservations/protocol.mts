import { HttpError } from '../../lib/http.mts';
export function object(value:unknown):Record<string,unknown>{if(typeof value!=='object'||value===null||Array.isArray(value))throw new HttpError(400,'invalid','Expected object');return value as Record<string,unknown>;}
export function identity(value:unknown):string{if(typeof value!=='string'||value.length<1||value.length>64||Buffer.from(value,'utf8').toString('utf8')!==value)throw new HttpError(400,'invalid','id: 1..64 well-formed UTF-16 units');return value;}
export function units(value:unknown):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1||value>1000000)throw new HttpError(400,'invalid','units: integer 1..1000000');return value;}
export function origin(name:string):string{const u=new URL(process.env[name]??'');if(u.protocol!=='http:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new Error(`Invalid ${name}`);return u.origin;}
export async function reply(response:Response):Promise<unknown>{
 if(!response.ok)throw new Error('Upstream status');
 if(!response.body)throw new Error('Missing body');
 const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1024)throw new Error('Upstream body too large');chunks.push(value);}return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;}finally{await reader.cancel();}
}
