import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { numberSetting, json } from '../../lib/http.mts';
export { json };
export async function listen(handler:(req:IncomingMessage,res:ServerResponse)=>Promise<void>) {
  const server = createServer({highWaterMark:1},(req,res)=> {
    handler(req,res).catch(()=> { if(!res.headersSent) json(res,502,{error:'invalid_stream'}); else res.destroy(); });
  });
  server.requestTimeout=5000; server.headersTimeout=5000;
  await new Promise<void>((resolve,reject)=> {server.once('error',reject); server.listen(numberSetting('PORT',0,0,65535),process.env.HOST ?? '127.0.0.1',resolve);});
  const address=server.address(); if(!address || typeof address==='string') throw new Error('address');
  console.log(JSON.stringify({port:address.port}));
  const stop=()=>{server.close(); server.closeAllConnections();};
  process.once('SIGTERM',stop); process.once('SIGINT',stop);
  server.once('close',()=>{process.off('SIGTERM',stop);process.off('SIGINT',stop);});
  return server;
}
export function lifetime(res:ServerResponse, milliseconds:number) {
  const controller=new AbortController();
  const close=()=>controller.abort();
  res.once('close',close);
  const timer=setTimeout(close,milliseconds);
  return {signal:controller.signal, clean:()=>{clearTimeout(timer);res.off('close',close);}};
}
export function barrier(signal:AbortSignal, subscribe:(release:()=>void)=>()=>void):Promise<void> {
  return new Promise((resolve,reject)=>{
    const done=()=>{cleanup();resolve();};
    const abort=()=>{cleanup();reject(new Error('aborted'));};
    const unsubscribe=subscribe(done);
    const cleanup=()=>{unsubscribe();signal.removeEventListener('abort',abort);};
    signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted) abort();
  });
}
