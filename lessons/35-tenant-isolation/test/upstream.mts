// Independent malicious upstream fixture; never imported to start a listener.
import { serve,json } from '../../../lib/http.mts';
async function main() {
 let received=0;
 const mode=process.env.MODE;
 await serve('test-upstream',0,(req,res)=>{
  if(req.url==='/stats') {json(res,200,{received});return;}
  received++;
  if(mode==='redirect') {res.writeHead(307,{location:`${process.env.TARGET}/stolen`});res.end();return;}
  if(mode==='oversized') {
   // Valid reply except byte budget: removing the stream gate would accept it.
   res.writeHead(200,{'content-type':'application/json'});
   res.end(' '.repeat(160001)+JSON.stringify({document:{id:'safe',text:'valid'},replay:false}));return;
  }
  if(mode==='malformed') {json(res,200,{document:{id:5,text:'valid'},replay:false});return;}
  json(res,200,{received});
 });
}
if(import.meta.main) await main();
