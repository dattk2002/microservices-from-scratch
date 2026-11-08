import {serve,json,HttpError,numberSetting} from '../../lib/http.mts';
import {identity,item,record,version,minVersion,fallback} from './store.mts';
import {body,origin,upstream,WRITE_BYTES} from './transport.mts';
export async function start(){
 const primary=origin('PRIMARY_ORIGIN'),replica=origin('REPLICA_ORIGIN');const timeout=numberSetting('DEADLINE_MS',800,10,5000);
 return serve('gateway',3930,async(req,res)=>{
 const u=new URL(req.url??'/','http://local'),match=/^\/items\/([^/]+)$/.exec(u.pathname);if(!match)throw new HttpError(404,'route','Unknown route');const id=identity(match[1]);
 if(u.searchParams.getAll('minVersion').length>1)throw new HttpError(400,'invalid','Repeated barrier');const minimum=minVersion(u.searchParams.get('minVersion'));
 const write=req.method==='POST';if(!write&&req.method!=='GET')throw new HttpError(405,'method','Unsupported method');
 const payload=write?{value:item({id,value:record(await body(req,WRITE_BYTES)).value}).value}:undefined;
 const signal=AbortSignal.timeout(timeout);const path=`/items/${id}${write?'':`?minVersion=${minimum}`}`;
 try {
 let source:'primary'|'replica'=write?'primary':'replica';let reply=await upstream(`${write?primary:replica}${path}`,signal,payload);
 if(!write&&fallback(reply.status,reply.body,minimum)){source='primary';reply=await upstream(`${primary}${path}`,signal);}
 const r=record(reply.body);if(r.source!==source)throw Error('Wrong source');const watermark=version(r.commitVersion);
 if(reply.status===200){const parsed=item(r.item);if(parsed.id!==id||watermark<minimum||(write&&watermark===0))throw Error('Stale/mismatched success');json(res,200,{item:parsed,commitVersion:watermark,source});return;}
 if(!write&&((reply.status===425&&fallback(425,r,minimum,source))||(reply.status===404&&r.error==='missing'&&watermark>=minimum))){json(res,reply.status,{error:r.error,commitVersion:watermark,source});return;}
 throw Error('Invalid upstream reply');
 }catch{json(res,signal.aborted?504:502,{error:signal.aborted?'deadline':'upstream'});}
 });
}
if(import.meta.main)await start();
