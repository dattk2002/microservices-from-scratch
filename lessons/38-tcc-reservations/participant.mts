import { DatabaseSync } from 'node:sqlite';
import { serve,readJson,json,HttpError,numberSetting } from '../../lib/http.mts';
import { Participant } from './store.mts';
import type { Phase } from './store.mts';
import { object,identity,units } from './protocol.mts';
export async function main(){
 const resource=process.env.RESOURCE;if(resource!=='inventory'&&resource!=='wallet')throw new Error('RESOURCE inventory|wallet');
 if(!process.env.DB_PATH)throw new Error('DB_PATH required');
 const db=new DatabaseSync(process.env.DB_PATH);const store=new Participant(db,numberSetting('CAPACITY',10,1,1000000));
 const failures=new Set<Phase>();
 const server=await serve(resource,3831,async(req,res)=>{
 if(req.method==='GET'&&req.url==='/state'){json(res,200,{resource,...store.state()});return;}
 if(req.method==='POST'&&req.url==='/teaching/failure'){
 if(process.env.TEACHING_CONTROLS!=='1')throw new HttpError(404,'not_found','Disabled');
 const b=object(await readJson(req));if(typeof b.phase!=='string'||(b.phase!=='try'&&b.phase!=='confirm'&&b.phase!=='cancel')||typeof b.enabled!=='boolean')throw new HttpError(400,'invalid','phase and enabled required');
 if(b.enabled)failures.add(b.phase);else failures.delete(b.phase);json(res,200,{ok:true});return;
 }
 if(req.method!=='POST'||(req.url!=='/try'&&req.url!=='/confirm'&&req.url!=='/cancel'))throw new HttpError(404,'not_found','Unknown route');
 const phase:Phase=req.url==='/try'?'try':req.url==='/confirm'?'confirm':'cancel';
 const b=object(await readJson(req));const id=identity(b.id),n=units(b.units);
 if(failures.has(phase))throw new HttpError(503,'teaching_failure','Injected before mutation');
 json(res,200,{resource,id,units:n,status:store.apply(phase,id,n)});
 });server.once('close',()=>db.close());return server;
}
if(import.meta.main)await main();
