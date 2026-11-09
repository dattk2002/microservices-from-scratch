import type { IncomingMessage } from 'node:http';
import { fail } from './store.mts';
// 1368 base64 characters * 6 escaped bytes + 64 digest characters * 6 + keys < 9000.
export async function body(req:IncomingMessage):Promise<unknown>{
 if(req.headers['content-type']?.split(';')[0]!=='application/json')fail(400);
 return new Promise((resolve,reject)=>{
 const chunks:Buffer[]=[];let size=0,settled=false;
 const timer=setTimeout(()=>{if(!settled){settled=true;reject(new Error('Body deadline'));req.destroy();}},1500);
 const stop=(error:unknown)=>{clearTimeout(timer);if(!settled){settled=true;reject(error);}};
 req.on('data',(chunk:Buffer)=>{if(settled)return;size+=chunk.length;if(size>9000){try{fail(413);}catch(e){stop(e);}}else chunks.push(chunk);});
 req.once('end',()=>{clearTimeout(timer);if(settled)return;settled=true;try{resolve(JSON.parse(Buffer.concat(chunks).toString()) as unknown);}catch{try{fail(400);}catch(e){reject(e);}}});
 req.once('error',stop);req.once('aborted',()=>stop(new Error('Aborted')));
 });
}
export async function bounded(response:Response):Promise<unknown>{
 if(!response.body)throw new Error('Missing body');const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
 try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>68000)throw new Error('Body budget');chunks.push(value);}return JSON.parse(Buffer.concat(chunks).toString()) as unknown;}finally{await reader.cancel();}
}
