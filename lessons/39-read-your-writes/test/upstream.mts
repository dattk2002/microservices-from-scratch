// Independent-process adversarial upstream, never a production teaching control.
import {serve,json} from '../../../lib/http.mts';
if(import.meta.main){
 let count=0;
 await serve('fixture',0,(req,res)=>{
 if(req.url==='/count'){json(res,200,{count});return;}
 count++;
 if(process.env.VARIANT==='primary'){json(res,200,{item:{id:'a',value:'fresh'},commitVersion:1,source:'primary'});return;}
 if(process.env.VARIANT?.startsWith('lag-')){
 const variant=process.env.VARIANT;
 json(res,425,{error:'lag',commitVersion:0,...(variant==='lag-missing'?{}:{source:variant==='lag-valid'?'replica':variant==='lag-boolean'?false:'primary'})});return;
 }
 if(process.env.VARIANT==='hang')return;
 if(process.env.VARIANT==='malformed'){json(res,200,{item:{id:'a',value:'old'},commitVersion:0,source:'replica'});return;}
 if(process.env.VARIANT==='sink'){json(res,200,{received:true});return;}
 res.writeHead(307,{location:process.env.TARGET??'http://127.0.0.1:1'});res.end();
 });
}
