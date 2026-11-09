import { json, serve } from '../../../lib/http.mts';
export async function main() {
  const mode=process.env.VARIANT; let reads=0,escaped=0;
  await serve('fixture',0,(req,res)=>{
    if(req.url==='/stats') return json(res,200,{reads,escaped});
    if(req.url==='/escaped') escaped++;
    if(req.url==='/state') reads++;
    const reply={actor:'a',state:{p:{a:1000000,b:1000000,c:1000000},n:{a:0,b:0,c:0}},value:3000000};
    if(mode==='redirect' && req.url==='/state') {res.writeHead(307,{location:(process.env.TARGET_ORIGIN ?? '')+'/escaped'});res.end();return;}
    if(mode==='timeout') return;
    if(mode==='body-timeout') {res.writeHead(200,{'content-type':'application/json'});res.write('{');return;}
    if(mode==='identity') reply.actor='c';
    if(mode==='value') reply.value=0;
    if(mode==='malformed') {res.end(JSON.stringify({...reply,state:null}));return;}
    // Whitespace preserves the complete valid schema, identity and derived value.
    if(mode==='oversized') {res.end(' '.repeat(2049)+JSON.stringify(reply));return;}
    // Worst-case escaping of all keys, still legal and below the byte budget.
    if(mode==='escaped') {res.end(JSON.stringify(reply).replace(/[apbncstvluero]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')));return;}
    json(res,200,reply);
  });
}
if(import.meta.main) await main();
