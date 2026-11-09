import { DatabaseSync } from 'node:sqlite';
import { HttpError, json, numberSetting, readJson, serve } from '../../lib/http.mts';
import { identity, integer, record, timerInput, Timers } from './store.mts';
import { controls, empty, openDatabase, originSetting } from './settings.mts';

// The same AbortSignal covers connection, headers AND streamed body reads.
async function acknowledge(origin:string,id:string,value:number,timeout:number):Promise<void> {
  const response=await fetch(origin+'/fire',{
    method:'POST',redirect:'error',headers:{'content-type':'application/json'},
    body:JSON.stringify({id,value}),signal:AbortSignal.timeout(timeout),
  });
  if(!response.ok){await response.body?.cancel();throw new Error('Receiver rejected delivery');}
  const reader=response.body?.getReader();if(!reader)throw new Error('Missing ack');
  let size=0; const chunks:Uint8Array[]=[];
  try {
    for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;
      if(size>1024)throw new Error('Ack exceeds 1024 bytes');chunks.push(part.value);}
  } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
  const raw:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const ack=record(raw);
  if(identity(ack.id)!==id||typeof ack.duplicate!=='boolean')throw new Error('Invalid acknowledgment');
  integer(ack.total,value,1600);
}

export async function main():Promise<void> {
  const teaching=controls();
  const epoch=process.env.TEACHING_EPOCH_SECONDS;
  if(epoch!==undefined&&!teaching)throw new Error('Fixed clock requires TEACHING_CONTROLS=1');
  const fixed=epoch===undefined?undefined:numberSetting('TEACHING_EPOCH_SECONDS',0,0,2147483647);
  const receiver=originSetting();
  const timeout=numberSetting('DELIVERY_TIMEOUT_MS',500,50,2000);
  const db:DatabaseSync=openDatabase();
  let offset=0,busy=false;
  const clock=()=> (fixed??Math.floor(Date.now()/1000))+offset;
  const timers=new Timers(db,clock);
  try {
    const server=await serve('durable-timer-scheduler',4646,async(req,res)=>{
      const path=new URL(req.url??'/', 'http://local').pathname;
      if(req.method==='GET'&&path==='/state'){json(res,200,{now:clock(),busy,timers:timers.list()});return;}
      const item=/^\/timers\/([A-Za-z0-9_-]{1,32})$/.exec(path);
      if(req.method==='GET'&&item){const t=timers.get(identity(item[1]));if(!t)throw new HttpError(404,'not_found','Unknown timer');json(res,200,t);return;}
      if(req.method==='POST'&&path==='/timers'){
        const input=timerInput(await readJson(req));
        // Synchronous admission after parsing: no await inside a state transition.
        json(res,200,timers.create(input));return;
      }
      const cancel=/^\/timers\/([A-Za-z0-9_-]{1,32})\/cancel$/.exec(path);
      if(req.method==='POST'&&cancel){empty(await readJson(req));json(res,200,timers.cancel(identity(cancel[1])));return;}
      if(req.method==='POST'&&path==='/dispatch'){
        empty(await readJson(req));
        if(busy)throw new HttpError(409,'busy','One dispatch is already active');
        busy=true;
        try {
          const t=timers.select(); // commit uncertain + attempt before first outbound await
          if(!t){json(res,200,{dispatched:false});return;}
          try {await acknowledge(receiver,t.id,t.value,timeout);timers.delivered(t.id);}
          catch {timers.failed(t.id);}
          json(res,200,{dispatched:true,...timers.get(t.id)});
        } finally {busy=false;}
        return;
      }
      if(req.method==='POST'&&path==='/teaching/advance'&&teaching){
        const body=record(await readJson(req));const seconds=integer(body.seconds,1,60);
        if(offset+seconds>3600)throw new HttpError(400,'offset_limit','Total teaching offset exceeds 3600');
        offset+=seconds;json(res,200,{now:clock(),offset});return;
      }
      throw new HttpError(404,'not_found','Unknown route');
    });
    server.once('close',()=>db.close());
  } catch(error){db.close();throw error;}
}
if(import.meta.main)await main();
