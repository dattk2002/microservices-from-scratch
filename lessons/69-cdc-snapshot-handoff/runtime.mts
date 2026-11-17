import type { IncomingMessage } from 'node:http';
import { resolve } from 'node:path';
import { HttpError, numberSetting } from '../../lib/http.mts';
import { fail, sourceOrigin } from './protocol.mts';

export function settings(role:'source'|'replica') {
 const host=process.env.HOST??'127.0.0.1';if(host!=='127.0.0.1')throw new Error('HOST must be 127.0.0.1');
 const port=numberSetting('PORT',role==='source'?3069:3070,0,65535);
 const path=process.env.DB_PATH;if(!path||path===':memory:')throw new Error('Durable private DB_PATH required');
 const origin=role==='replica'?sourceOrigin(process.env.SOURCE_ORIGIN):undefined;
 if(origin&&port!==0&&origin===new URL(`http://${host}:${port}`).origin)throw new Error('Source and replica origins must be distinct');
 return {path:resolve(path),origin};
}

// Remove listeners on every exit; a slow inbound body must not hold the gate forever.
export function readBody(req:IncomingMessage,deadline=performance.now()+500):Promise<unknown> {
 if(req.headers['content-type']?.split(';')[0]?.trim().toLowerCase()!=='application/json')return Promise.reject(new HttpError(415,'unsupported_media_type','Use application/json'));
 return new Promise((resolve,reject)=>{
  const chunks:Buffer[]=[];let size=0;
  const clean=()=>{
   clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('error',error);req.off('aborted',aborted);
  };
  const error=(reason:unknown)=>{clean();req.resume();reject(reason);};
  const aborted=()=>error(new HttpError(400,'request_aborted','Request was interrupted'));
  const data=(chunk:Buffer)=>{
   size+=chunk.length;
   if(size>8192)error(new HttpError(413,'body_too_large','JSON body exceeds 8192 bytes'));else chunks.push(chunk);
  };
  const end=()=>{
   clean();try{const value:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));resolve(value);}
   catch{reject(new HttpError(400,'invalid_json','Body must be valid JSON'));}
  };
  const timer=setTimeout(()=>{
   try{fail(408,'request_timeout');}catch(reason){error(reason);}
  },Math.max(1,Math.ceil(deadline-performance.now())));
  req.on('data',data);req.once('end',end);req.once('error',error);req.once('aborted',aborted);
 });
}
