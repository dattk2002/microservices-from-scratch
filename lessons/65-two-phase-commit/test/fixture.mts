// Bounded local upstream used only by HTTP tests; never a playground entrypoint.
import { serve, json, readJson } from '../../../lib/http.mts';
import { Participant } from '../store.mts';
import { fail, fields, tuple, parseTxId, parseAmount, parseDecision, origins, object } from '../protocol.mts';
import type { Tuple } from '../protocol.mts';
import { setTimeout as delay } from 'node:timers/promises';
const modes=['normal','escaped','oversize','malformed','null','array','primitive','extra','wrong_id','wrong_amount','wrong_terminal','wrong_vote','redirect','drop_once','delayed_body','hold','error404','error409','error422','error429','unexpected_code'];

// Only decoded string tokens are escaped: numeric/boolean/null tokens stay JSON.
export function escaped(value:unknown) {
 return JSON.stringify(value).replace(/"(?:[^"\\]|\\.)*"/g,token=>{
  const decoded:unknown=JSON.parse(token);if(typeof decoded!=='string')throw new Error('Expected string token');
  return '"'+Array.from(decoded,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('')+'"';
 });
}
export async function main() {
 const id=process.env.PARTICIPANT_ID;if(id!=='a'&&id!=='b')throw new Error('Fixture identity required');
 const path=process.env.DB_PATH;if(!path)throw new Error('Fixture DB required');
 const redirect=process.env.REDIRECT_ORIGIN;
 if(redirect)origins(redirect,'http://127.0.0.1:1');
 const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(path);
 try{
  const p=new Participant(db,id);let mode='normal',calls=0;
  const waiting=new Set<()=>void>();
  const server=await serve('2pc-test-upstream',0,async(req,res)=>{
   if(req.url?.startsWith('/teaching/')&&process.env.TEACHING_CONTROLS!=='1')fail(404,'not_found');
   if(req.method==='GET'&&req.url==='/teaching/stats')return json(res,200,{calls,waiting:waiting.size});
   if(req.method==='GET'&&req.url==='/state')return json(res,200,p.state());
   if(req.method==='POST'&&req.url==='/teaching/mode'){
    const b=fields(await readJson(req),['mode']);
    if(typeof b.mode!=='string'||!modes.includes(b.mode))fail(400,'invalid_body');
    if(b.mode==='redirect'&&!redirect)fail(400,'invalid_body');
    mode=b.mode;return json(res,200,{ok:true});
   }
   if(req.method==='POST'&&req.url==='/teaching/release'){
    fields(await readJson(req),[]);for(const release of waiting)release();waiting.clear();return json(res,200,{ok:true});
   }
   if(req.method!=='POST'||(req.url!=='/prepare'&&req.url!=='/decide'))fail(404,'not_found');
   const b=await readJson(req);let expected:Tuple;let decision:'commit'|'abort'|undefined;
   if(req.url==='/prepare')expected=tuple(b);
   else{const t=fields(b,['txId','amount','decision']);expected={txId:parseTxId(t.txId),amount:parseAmount(t.amount)};decision=parseDecision(t.decision);}
   calls++;const current=mode;
   if(current==='redirect'){res.writeHead(307,{location:redirect+req.url});res.end();return;}
   if(current.startsWith('error'))return json(res,Number(current.slice(5)),{error:{code:'internal_error',message:'internal_error'}});
   if(current==='unexpected_code')return json(res,200,{error:{code:'internal_error',message:'internal_error'}});
   let value:unknown;
   if(decision===undefined)value=process.env.WIRE_ONLY==='1'?{...expected,vote:'yes'}:p.prepare(expected.txId,expected.amount);
   else value=process.env.WIRE_ONLY==='1'?{...expected,phase:decision==='commit'?'committed':'aborted'}:p.decide(expected.txId,expected.amount,decision);
   if(current==='drop_once'){mode='normal';res.destroy();return;}
   if(current==='hold')await new Promise<void>(resolve=>{waiting.add(resolve);});
   if(current==='delayed_body'){
    await delay(300);if(res.destroyed)return;
    res.writeHead(200,{'content-type':'application/json'});res.flushHeaders();
    await delay(350);if(!res.destroyed)res.end(JSON.stringify(value));return;
   }
   if(current==='null')value=null;
   if(current==='array')value=[];
   if(current==='primitive')value='yes';
   if(current==='extra')value={...expected,...(req.url==='/prepare'?{vote:'yes'}:{phase:'committed'}),extra:true};
   if(current==='wrong_id'&&object(value))value={...value,txId:'other'};
   if(current==='wrong_amount'&&object(value))value={...value,amount:4};
   if(current==='wrong_terminal')value={...expected,phase:'aborted'};
   if(current==='wrong_vote')value={...expected,vote:true};
   res.writeHead(200,{'content-type':'application/json'});
   if(current==='malformed')res.end('{');
   else if(current==='oversize')res.end(' '.repeat(1025)+JSON.stringify(value));
   else if(current==='escaped')res.end(escaped(value));
   else res.end(JSON.stringify(value));
  });
  server.once('close',()=>{for(const release of waiting)release();waiting.clear();db.close();});return server;
 }catch(error){db.close();throw error;}
}
if(import.meta.main)await main();
