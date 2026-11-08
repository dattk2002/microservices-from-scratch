import { serve,json,HttpError,numberSetting } from '../../lib/http.mts';
import { Store,identity,item,minVersion,record } from './store.mts';
import {body,origin,upstream,WRITE_BYTES,SNAPSHOT_BYTES} from './transport.mts';
export async function start(role:'primary'|'replica') {
 const target=role==='primary'?origin('REPLICA_ORIGIN'):'';
 const store=new Store(process.env.DB_PATH??`${role}.sqlite`);
 let held=false;
 const replicate=async()=>{const reply=await upstream(`${target}/snapshot`,AbortSignal.timeout(500),store.snapshot());const r=record(reply.body);if(reply.status!==200||typeof r.result!=='string'||!['applied','duplicate','older'].includes(r.result))throw Error('Invalid replication reply');};
 try {const server=await serve(role,role==='primary'?3931:3932,async(req,res)=>{
 const u=new URL(req.url??'/', 'http://local');
 if(role==='primary'&&process.env.TEACHING_CONTROLS==='1'&&req.method==='POST'){
 if(u.pathname==='/replication/hold'){held=true;json(res,200,{held});return;}
 if(u.pathname==='/replication/release'){held=false;json(res,200,{held});return;}
 if(u.pathname==='/replicate'){try{await replicate();json(res,200,{replicated:true});}catch{throw new HttpError(503,'unavailable','Replication failed');}return;}
 }
 if(u.pathname==='/snapshot'){
 if(req.method==='GET'&&role==='primary'){json(res,200,store.snapshot());return;}
 if(req.method==='POST'&&role==='replica'){json(res,200,{result:store.apply(await body(req,SNAPSHOT_BYTES))});return;}
 }
 const match=/^\/items\/([^/]+)$/.exec(u.pathname);if(!match)throw new HttpError(404,'route','Unknown route');const id=identity(match[1]);
 if(req.method==='POST'&&role==='primary'){
 const input=record(await body(req,WRITE_BYTES));const parsed=item({id,value:input.value});const result=store.write(id,parsed.value);
 if(!held)void replicate().catch(()=>{});json(res,200,{...result,source:role});return;
 }
 if(req.method==='GET'){
 if(u.searchParams.getAll('minVersion').length>1)throw new HttpError(400,'invalid','Repeated barrier');
 const minimum=minVersion(u.searchParams.get('minVersion'));const s=store.snapshot();
 if(s.commitVersion<minimum){json(res,425,{error:'lag',commitVersion:s.commitVersion,source:role});return;}
 const found=s.items.find(x=>x.id===id);json(res,found?200:404,found?{item:found,commitVersion:s.commitVersion,source:role}:{error:'missing',commitVersion:s.commitVersion,source:role});return;
 }
 throw new HttpError(405,'method','Unsupported method');
 });server.once('close',()=>store.close());return server;}catch(e){store.close();throw e;}
}
