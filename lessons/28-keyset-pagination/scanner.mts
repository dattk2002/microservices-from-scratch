import { ScannerStore,binding } from './store.mts';
import type { Page } from './store.mts';
import { serve,json,readJson,HttpError } from '../../lib/http.mts';
async function remote(base:string,path:string,body:unknown):Promise<unknown>{
 const response=await fetch(new URL(path,base),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(1500)});
 const chunks:Uint8Array[]=[];let bytes=0;
 if(response.body){const reader=response.body.getReader();try{while(true){const item=await reader.read();if(item.done)break;bytes+=item.value.byteLength;if(bytes>16384){await reader.cancel();throw new HttpError(502,'response_limit','response limit');}chunks.push(item.value);}}finally{reader.releaseLock();}}
 const text=Buffer.concat(chunks).toString('utf8');
 if(!response.ok)throw new HttpError(response.status,'owner_rejected',text);
 return JSON.parse(text) as unknown;
}
function decodePage(value:unknown):Page {
 if(!value||typeof value!=='object'||!('rows' in value)||!('next' in value)||!Array.isArray(value.rows)||value.rows.length>10||!(value.next===null||typeof value.next==='string'&&/^[a-f0-9]{48}$/.test(value.next)))throw new HttpError(502,'page','invalid page');
 const rows=value.rows.map((row:unknown)=>{
 if(!row||typeof row!=='object'||!('id' in row)||!('kind' in row)||!('value' in row)||typeof row.id!=='number'||!Number.isSafeInteger(row.id)||row.id<1||typeof row.kind!=='string'||!['a','b'].includes(row.kind)||typeof row.value!=='string'||Buffer.byteLength(row.value)>128)throw new HttpError(502,'row','invalid row');
 return {id:row.id,kind:row.kind,value:row.value};});
 return {rows,next:value.next};
}
export async function main(){
 const base=new URL(process.env.OWNER_URL??'http://127.0.0.1:3028');
 if(base.protocol!=='http:'||base.hostname!=='127.0.0.1')throw new Error('loopback owner required');
 const store=new ScannerStore(process.env.DB_PATH??'scanner.sqlite');let busy=false;
 try{const server=await serve('scanner',3029,async(req,res)=>{
 if(req.method==='GET'&&req.url==='/state'){json(res,200,{checkpoint:store.state(),rows:store.rows()});return;}
 if(req.method!=='POST')throw new HttpError(405,'method','POST required');
 if(busy)throw new HttpError(409,'busy','one operation at a time');busy=true;
 try{
 const body=await readJson(req);if(!body||typeof body!=='object'||Array.isArray(body))throw new HttpError(400,'body','object required');const b=body as Record<string,unknown>;
 if(req.url==='/begin'){
 binding(b.kind,b.size);if(store.state()&&!b.replace)throw new HttpError(409,'scan_exists','explicit replace required');
 if(b.replace!==undefined&&b.replace!==true)throw new HttpError(400,'replace','boolean true required');
 const result=await remote(base.href,'/snapshots',{kind:b.kind,size:b.size});
 if(!result||typeof result!=='object'||Array.isArray(result)||!('token' in result)||typeof result.token!=='string'||! /^[a-f0-9]{48}$/.test(result.token))throw new HttpError(502,'snapshot_reply','invalid snapshot token');
 store.begin(result.token,b.kind,b.size as number,Date.now()+30000);json(res,201,{ok:true});
 }else if(req.url==='/step'){
 const s=store.state();if(!s)throw new HttpError(409,'no_scan','begin first');
 if(s.done){json(res,200,{done:true});return;}
 if(Date.now()>=Number(s.deadline))throw new HttpError(410,'scan_deadline','start deliberate new scan');
 const page=decodePage(await remote(base.href,'/page',{token:s.token,kind:s.kind,size:s.size}));
 const interrupt=process.env.TEACHING_CONTROLS==='1'&&b.interrupt===true;
 if(Date.now()>=Number(s.deadline))throw new HttpError(410,'scan_deadline','deadline exceeded');
 store.apply(String(s.token),page,interrupt);json(res,200,{done:page.next===null});
 }else throw new HttpError(404,'route','unknown route');
 }finally{busy=false;}
 });server.once('close',()=>store.close());}catch(e){store.close();throw e;}
}
if(import.meta.main)await main();
