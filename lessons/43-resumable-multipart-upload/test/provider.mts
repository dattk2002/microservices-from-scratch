import { serve,json,readJson } from '../../../lib/http.mts';
import { createHash } from 'node:crypto';
import { record,fail } from '../store.mts';
if(import.meta.main){
 let mode='valid',hits=0;
 const bytes=Buffer.from('a'),valid={id:'demo',base64:'YQ==',size:1,sha256:createHash('sha256').update(bytes).digest('hex')};
 await serve('provider',0,async(req,res)=>{
 if(req.url==='/control'&&req.method==='POST'){const v=record(await readJson(req));if(typeof v.mode!=='string'||!['valid','malformed','oversized','slow','redirect','schema','checksum','missing','escaped'].includes(v.mode))fail(400);mode=v.mode;hits=0;json(res,200,{});return;}
 if(req.url==='/hits'){json(res,200,{hits});return;}
 if(req.url==='/target'){hits++;json(res,200,valid);return;}
 if(mode==='redirect'){res.writeHead(302,{location:process.env.TARGET_ORIGIN+'/target'});res.end();return;}
 if(mode==='missing'){json(res,404,{});return;}
 if(mode==='malformed'){res.writeHead(200,{'content-type':'application/json'});res.end('{');return;}
 if(mode==='slow'){res.writeHead(200,{'content-type':'application/json'});res.write('{');return;}
 if(mode==='oversized'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(valid)+' '.repeat(68001));return;}
 if(mode==='escaped'){const b=Buffer.alloc(8192,255);const v={id:'demo',base64:b.toString('base64'),size:b.length,sha256:createHash('sha256').update(b).digest('hex')};res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(v).replaceAll('/','\\u002f'));return;}
 json(res,200,mode==='schema'?{...valid,size:'1'}:mode==='checksum'?{...valid,sha256:'0'.repeat(64)}:valid);
 });
}
