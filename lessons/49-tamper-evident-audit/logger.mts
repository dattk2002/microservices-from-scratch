import {DatabaseSync} from 'node:sqlite';
import {serve,json,readJson} from '../../lib/http.mts';
import {Log,fail,object,keys,view} from './model.mts';
import type {Mode} from './model.mts';
export async function main(){
 const db=new DatabaseSync(process.env.DB_PATH??'logger.sqlite');const log=new Log(db);let mode:Mode='clean';
 try{
 const server=await serve('audit-logger',4941,async(req,res)=>{
 if(req.method==='POST'&&req.url==='/entries'){json(res,200,log.append(await readJson(req)));return;}
 if(req.method==='GET'&&req.url==='/export'){json(res,200,view(log.export(),mode));return;}
 if(req.method==='POST'&&req.url==='/teaching/view'&&process.env.TEACHING_CONTROLS==='1'){
 const o=object(await readJson(req));keys(o,['mode']);if(typeof o.mode!=='string'||(o.mode!=='clean'&&o.mode!=='edit'&&o.mode!=='truncate'&&o.mode!=='rewrite'))fail(400,'invalid_mode');
 view(log.export(),o.mode);mode=o.mode;json(res,200,{mode});return;
 }fail(404,'not_found');
 });server.once('close',()=>db.close());return server;
 }catch(e){db.close();throw e;}
}
if(import.meta.main)await main();
