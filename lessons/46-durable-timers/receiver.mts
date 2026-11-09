import { HttpError, json, readJson, serve } from '../../lib/http.mts';
import { record, Receipts } from './store.mts';
import { controls, openDatabase } from './settings.mts';
export async function main():Promise<void> {
  const teaching=controls();const db=openDatabase();const receipts=new Receipts(db);
  let afterCommit=false;
  try {
    const server=await serve('durable-timer-receiver',4647,async(req,res)=>{
      const path=new URL(req.url??'/','http://local').pathname;
      if(req.method==='GET'&&path==='/state'){
        const rows=receipts.list();json(res,200,{receipts:rows,total:receipts.total()});return;
      }
      if(req.method==='POST'&&path==='/fire'){
        const result=receipts.accept(await readJson(req));
        if(afterCommit&&!result.duplicate)throw new HttpError(503,'reply_lost','Receipt committed, simulated error reply');
        json(res,200,result);return;
      }
      if(req.method==='POST'&&path==='/teaching/failure'&&teaching){
        const body=record(await readJson(req));
        if(typeof body.afterCommit!=='boolean')throw new HttpError(400,'invalid_flag','Expected boolean afterCommit');
        afterCommit=body.afterCommit;json(res,200,{afterCommit});return;
      }
      throw new HttpError(404,'not_found','Unknown route');
    });
    server.once('close',()=>db.close());
  }catch(error){db.close();throw error;}
}
if(import.meta.main)await main();
