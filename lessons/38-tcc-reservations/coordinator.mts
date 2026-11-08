import { DatabaseSync } from 'node:sqlite';
import { serve,readJson,json,HttpError } from '../../lib/http.mts';
import { Transactions } from './store.mts';
import type { Transaction,Phase } from './store.mts';
import { object,identity,units,origin,reply } from './protocol.mts';
export async function main(){
 const origins={inventory:origin('INVENTORY_ORIGIN'),wallet:origin('WALLET_ORIGIN')};
 if(!process.env.DB_PATH)throw new Error('DB_PATH required');
 const db=new DatabaseSync(process.env.DB_PATH),store=new Transactions(db);let busy=false;
 async function deliver(t:Transaction,resource:'inventory'|'wallet',phase:Phase){
 const n=resource==='inventory'?t.quantity:t.amount;
 const response=await fetch(`${origins[resource]}/${phase}`,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({id:t.id,units:n}),signal:AbortSignal.timeout(700)});
 const b=object(await reply(response));
 if(b.id!==t.id||b.units!==n||b.resource!==resource||typeof b.status!=='string'||(phase==='try'?b.status!=='held'&&b.status!=='confirmed':b.status!==(phase==='confirm'?'confirmed':'cancelled')))throw new Error('Invalid upstream reply');
 }
 async function recover(id:string){let t=store.get(id)!;
 if(t.decision==='undecided')store.decide(id,'abort');t=store.get(id)!;
 for(const r of ['inventory','wallet'] as const){if(t[r])continue;try{await deliver(t,r,t.decision==='commit'?'confirm':'cancel');store.acknowledge(id,r);}catch{/* Explicit pending; next operator command retries. */}}
 return store.get(id)!;
 }
 const server=await serve('coordinator',3830,async(req,res)=>{
 if(req.method==='GET'&&req.url?.startsWith('/transactions/')){
 let id:string;try{id=decodeURIComponent(req.url.slice(14));}catch{throw new HttpError(400,'invalid','Malformed escaped transaction id');}
 const t=store.get(identity(id));if(!t)throw new HttpError(404,'not_found','Unknown transaction');json(res,200,t);return;}
 if(req.method!=='POST'||(req.url!=='/transactions'&&req.url!=='/recover'))throw new HttpError(404,'not_found','Unknown route');
 if(busy)throw new HttpError(503,'busy','One operation admitted at a time');busy=true;
 try{const b=object(await readJson(req)),id=identity(b.id);
 if(req.url==='/transactions'){
 const existing=store.get(id);const t=store.bind(id,units(b.quantity),units(b.amount));
 if(!existing){try{await deliver(t,'inventory','try');await deliver(t,'wallet','try');store.decide(id,'commit');}catch{store.decide(id,'abort');}}
 }else if(!store.get(id))throw new HttpError(404,'not_found','Unknown transaction');
 const t=await recover(id);json(res,t.status==='pending'?202:200,t);
 }finally{busy=false;}
 });server.once('close',()=>db.close());return server;
}
if(import.meta.main)await main();
