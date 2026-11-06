import type { IncomingMessage } from 'node:http';
import { HttpError } from '../../lib/http.mts';
export { json,readJson,serve } from '../../lib/http.mts';
export function route(req: IncomingMessage): {id?:string} {
 const url=new URL(req.url??'/', 'http://local');
 if(url.search || (req.url?.length??0)>256) throw new HttpError(400,'invalid_route','No tenant hints or query parameters');
 if(url.pathname==='/documents') return {};
 const match=/^\/documents\/([a-zA-Z0-9_-]{1,64})$/.exec(url.pathname);
 if(!match?.[1]) throw new HttpError(404,'not_found','Not found');
 return {id:match[1]};
}
export async function boundedReply(response: Response): Promise<unknown> {
 if(!response.body) throw Error('Missing upstream body');
 const reader=response.body.getReader(); const chunks:Uint8Array[]=[];let size=0;
 try {
  while(true) {const next=await reader.read();if(next.done)break;size+=next.value.length;
   if(size>160000) throw Error('Upstream body too large');chunks.push(next.value);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
 } finally {await reader.cancel();}
}
