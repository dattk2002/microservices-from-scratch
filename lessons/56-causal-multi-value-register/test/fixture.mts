import {serve,json,readJson,HttpError} from '../../../lib/http.mts';
import {object} from '../model.mts';
// Test-only bounded upstream, reusable without hiding redirect evidence.
export async function main(){
 let mode='ok',hits=0;
 const state={context:{a:16,b:16},siblings:[{dot:{actor:'a',counter:16},value:'x'.repeat(32)},{dot:{actor:'b',counter:16},value:'y'.repeat(32)}]};
 const escapeStrings=(s:string)=>s.replace(/"(?:[^"\\]|\\.)*"/g,token=>{
 const decoded:unknown=JSON.parse(token);if(typeof decoded!=='string')throw new Error('String token');
 return '"'+Array.from(decoded,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('')+'"';
 });
 return serve('fixture',5658,async(req,res)=>{
 if(req.url==='/control'&&process.env.TEACHING_CONTROLS==='1'&&req.method==='POST'){
 const x=object(await readJson(req),['mode']);if(typeof x.mode!=='string'||!['ok','escaped','oversize','status','missing','malformed','primitive','slow','redirect','conflict','conflict-null','conflict-array','conflict-number','conflict-unrelated','conflict-extra','drop','delay','slowbody'].includes(x.mode))throw new HttpError(400,'mode','Invalid mode');mode=x.mode;return json(res,200,{hits});
 }
 if(req.url==='/hits'&&process.env.TEACHING_CONTROLS==='1')return json(res,200,{hits});
 if(req.url!=='/value'&&req.url!=='/merge')throw new HttpError(404,'route','Missing');
 hits++;
 if(mode==='drop'){req.socket.destroy();return;}
 if(mode==='redirect'){res.writeHead(307,{location:process.env.DESTINATION+'/merge'});res.end();return;}
 if(mode==='slowbody'){res.writeHead(200,{'content-type':'application/json'});res.write('{');const timer=setTimeout(()=>res.end('}'),450);res.once('close',()=>clearTimeout(timer));return;}
 if(mode==='delay'){await new Promise<void>(resolve=>{const timer=setTimeout(resolve,180);res.once('close',()=>{clearTimeout(timer);resolve();});});if(res.destroyed)return;}
 if(mode==='slow'){const timer=setTimeout(()=>json(res,200,state),450);res.once('close',()=>clearTimeout(timer));return;}
 if(mode==='status'||mode==='missing'){json(res,mode==='missing'?404:503,{error:'fixture'});return;}
 if(mode.startsWith('conflict')){
 const valid={error:{code:'register_error',message:'Invalid or conflicting register operation'}};
 const body=mode==='conflict-null'?null:mode==='conflict-array'?[]:mode==='conflict-number'?1:mode==='conflict-unrelated'?{error:'conflict'}:mode==='conflict-extra'?{...valid,extra:true}:valid;
 json(res,409,body);return;
 }
 if(mode==='primitive'){json(res,200,null);return;}
 if(mode==='malformed'){res.end('{');return;}
 const body=escapeStrings(JSON.stringify(state));
 res.setHeader('content-type','application/json');res.end(mode==='oversize'?body+' '.repeat(2049):mode==='escaped'?body:JSON.stringify(state));
 });
}
if(import.meta.main)await main();
