import { DatabaseSync } from 'node:sqlite';
import { HttpError,json,numberSetting,serve } from '../../lib/http.mts';
import { Consumer,event,integer,record } from './model.mts';
import { admitted,body,BODY_BYTES,origin } from './runtime.mts';

export async function fetchBatch(broker:string,partition:number,after:number,requestMs:number,total:AbortSignal) {
  const signal=AbortSignal.any([total,AbortSignal.timeout(requestMs)]);
  const response=await fetch(`${broker}/events?partition=${partition}&after=${after}&limit=8`,{signal,redirect:'error'});
  try {
    if(!response.ok || response.headers.get('content-type')?.split(';')[0]?.trim()!=='application/json')throw new Error('upstream status or media type');
    if(!response.body)throw new Error('missing upstream body');
    const reader=response.body.getReader();
    const chunks:Uint8Array[]=[];
    let size=0;
    try {
      for(;;) {
        const part=await reader.read();
        if(part.done)break;
        size+=part.value.byteLength;
        if(size>BODY_BYTES)throw new Error('upstream body too large');
        chunks.push(part.value);
      }
    } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
    const envelope=record(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
    if(envelope.partition!==partition || envelope.after!==after || !Array.isArray(envelope.events) || envelope.events.length>8)throw new Error('upstream envelope');
    const events=envelope.events.map(event);
    for(const [i,e] of events.entries()) {
      if(e.partition!==partition || e.offset!==after+i+1)throw new Error('upstream sequence');
    }
    signal.throwIfAborted();
    return events;
  } finally {await response.body?.cancel().catch(()=>{});}
}
export async function main() {
  // Configuration, storage, signals and listeners are deliberately inside main.
  const broker=origin(process.env.BROKER_ORIGIN);
  const requestMs=numberSetting('POLL_REQUEST_MS',400,50,2000);
  const totalMs=numberSetting('POLL_TOTAL_MS',800,50,4000);
  const db=new DatabaseSync(process.env.DB_PATH??'consumer.sqlite');
  try {
    const consumer=new Consumer(db);
    const polling=new Set<number>();
    const server=await serve('partition-consumer',4037,admitted(async(req,res)=>{
      const path=new URL(req.url??'/', 'http://local').pathname;
      if(path==='/state' && req.method==='GET') {json(res,200,consumer.state());return;}
      if(path==='/deliver' && req.method==='POST') {
        const e=event(await body(req));
        consumer.apply([e]);json(res,200,consumer.state());return;
      }
      if(path==='/poll' && req.method==='POST') {
        const total=AbortSignal.timeout(totalMs);
        const partition=integer(record(await body(req,total)).partition,0,2);
        if(polling.has(partition))throw new HttpError(503,'busy','partition poll already active');
        polling.add(partition);
        try {
          const after=consumer.checkpoint(partition);
          const events=await fetchBatch(broker,partition,after,requestMs,total).catch(()=>{
            throw new HttpError(502,'upstream','invalid, redirected or timed out broker reply');
          });
          if(total.aborted)throw new HttpError(502,'upstream','poll total deadline');
          consumer.apply(events);
          json(res,200,{applied:events.length,...consumer.state()});return;
        } finally {polling.delete(partition);}
      }
      throw new HttpError(404,'not_found','unknown route');
    }));
    server.once('close',()=>db.close());return server;
  }catch(error){db.close();throw error;}
}
if(import.meta.main) await main();
