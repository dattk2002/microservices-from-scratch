import { serve, json } from '../../lib/http.mts';
import { ReceiptStore, secretSetting, rawBody, parse, event, object, verify, fail } from './core.mts';
export async function main() {
 const secret=secretSetting();
 const path=process.env.DB_PATH; if(!path) throw new Error('DB_PATH required');
 const controls=process.env.TEACHING_CONTROLS==='1';
 let now:number|undefined;
 if(process.env.TEACHING_EPOCH!==undefined) {
  if(!controls|| !/^[1-9][0-9]{0,9}$/.test(process.env.TEACHING_EPOCH)) throw new Error('Invalid teaching epoch');
  now=Number(process.env.TEACHING_EPOCH);
 }
 let afterCommit=false;
 const store=new ReceiptStore(path);
 try {
 const server=await serve('signed-webhook-receiver',4242,async(req,res)=>{
  if(req.method==='GET'&&req.url==='/state') {json(res,200,store.state());return;}
  if(req.method==='POST'&&req.url==='/teaching/failure'&&controls) {
   const o=object(parse(await rawBody(req)));
   if(typeof o.afterCommit!=='boolean') fail(400,'invalid_control');
   afterCommit=o.afterCommit;json(res,200,{afterCommit});return;
  }
  if(req.method==='POST'&&req.url==='/teaching/clock'&&controls) {
   const o=object(parse(await rawBody(req)));
   if(typeof o.advance!=='number'||!Number.isInteger(o.advance)||o.advance<0||o.advance>120) fail(400,'invalid_control');
   now=(now??Math.floor(Date.now()/1000))+o.advance;json(res,200,{now});return;
  }
  if(req.method==='POST'&&req.url==='/webhook') {
   const raw=await rawBody(req);
   if(!verify(secret,req.headers['x-demo-timestamp'],req.headers['x-demo-signature'],raw,now??Math.floor(Date.now()/1000))) fail(403,'invalid_credentials');
   const result=store.apply(event(parse(raw)));
   json(res,afterCommit&&!result.duplicate?503:200,result);return;
  }
  fail(404,'not_found');
 });
 server.once('close',()=>store.db.close());
 } catch(error) {store.db.close();throw error;}
}
if(import.meta.main) await main();
