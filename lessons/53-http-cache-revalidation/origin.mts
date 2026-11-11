import {serve,json,HttpError} from '../../lib/http.mts';
import {language,parseDocument} from './model.mts';
import {clock,input,bad,send} from './runtime.mts';
export async function main(){
  const time=clock(); const {DatabaseSync}=await import('node:sqlite'); const db=new DatabaseSync(process.env.DB_PATH??'documents.sqlite');
  try{
    db.exec("CREATE TABLE IF NOT EXISTS documents(language TEXT PRIMARY KEY, version INTEGER NOT NULL,text TEXT NOT NULL,policy TEXT NOT NULL); INSERT OR IGNORE INTO documents VALUES('en',1,'Hello','public'),('vi',1,'Xin_chao','public')");
    let available=true;let requests=0;let notModified=0;
    const server=await serve('http-origin',3053,async(req,res)=>{
      if(await time.route(req,res))return;
      if(time.controls&&req.url==='/teaching/state'&&req.method==='GET'){json(res,200,{requests,notModified});return;}
      if(time.controls&&req.url==='/teaching/availability'&&req.method==='POST'){
        const v=await input(req);if(typeof v.available!=='boolean')throw bad();available=v.available;json(res,200,{available});return;
      }
      if(time.controls&&req.url==='/teaching/content'&&req.method==='POST'){
        const v=await input(req);let body;try{body=parseDocument(v,language(v.language));}catch{throw bad();}
        if(typeof v.policy!=='string'||!['public','private','no-store'].includes(v.policy))throw bad();
        const old=db.prepare('SELECT * FROM documents WHERE language=?').get(body.language);
        if(!old)throw new Error('Missing row');
        if(body.version<=Number(old.version)&&!(body.version===old.version&&body.text===old.text&&v.policy===old.policy))throw new HttpError(409,'conflict','Version must increase or replay exactly');
        db.prepare('UPDATE documents SET version=?,text=?,policy=? WHERE language=?').run(body.version,body.text,v.policy,body.language);json(res,200,body);return;
      }
      if(req.url!=='/document'||req.method!=='GET'){json(res,404,{error:'not_found'});return;}
      let lang;try{lang=language(req.headers['accept-language']);}catch{throw bad();}
      requests=Math.min(1000000,requests+1);if(!available){json(res,503,{error:'unavailable'});return;}
      const row=db.prepare('SELECT * FROM documents WHERE language=?').get(lang);if(!row)throw new Error('Missing row');
      const body=parseDocument(row,lang);const etag=`"${lang}-${body.version}"`;
      const headers={etag,vary:'Accept-Language',date:new Date(time.now()*1000).toUTCString(),age:'0','cache-control':row.policy==='public'?'public,max-age=5,must-revalidate':String(row.policy)};
      const status=req.headers['if-none-match']===etag?304:200;if(status===304)notModified=Math.min(1000000,notModified+1);
      send(res,status,body,headers);
    });server.once('close',()=>db.close());return server;
  }catch(error){db.close();throw error;}
}
if(import.meta.main)await main();
