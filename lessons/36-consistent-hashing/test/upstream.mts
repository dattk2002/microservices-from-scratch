import { serve, json } from '../../../lib/http.mts';
import { createHash } from 'node:crypto';
if (import.meta.main) {
  const mode = process.env.MODE;
  let requests = 0; let redirects = 0;
  await serve('fixture',0,(req,res)=>{
    if(req.url==='/stats') {json(res,200,{requests,redirects}); return;}
    if(req.url==='/destination') {redirects++; json(res,200,{}); return;}
    requests++;
    if(mode==='hang') return;
    if(mode==='redirect') {res.writeHead(307,{location:`${process.env.DESTINATION ?? ''}/destination`}); res.end(); return;}
    const key = decodeURIComponent((req.url ?? '').slice('/objects/'.length));
    const correctValue = createHash('sha256').update(`catalogue-v1:${key}`).digest('hex');
    const value = mode==='value'?'0'.repeat(64):correctValue;
    const data = {key,owner:mode==='identity'?'b':'a',hit:mode==='schema'?'false':false,value};
    const raw = JSON.stringify(data);
    // Same valid maximal object; only trailing legal JSON whitespace crosses byte gate.
    const target = mode==='bytes'?641:640;
    res.writeHead(mode==='status'?503:200,{'content-type':mode==='type'?'text/plain':'application/json'});
    if(mode==='bodyhang') {res.flushHeaders(); res.write(raw.slice(0,20)); return;}
    res.end(raw+' '.repeat(target-Buffer.byteLength(raw)));
  });
}
