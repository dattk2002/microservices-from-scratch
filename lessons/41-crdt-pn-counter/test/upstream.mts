import { HttpError, json, readJson, serve } from '../../../lib/http.mts';
export async function main() {
  let mode=process.env.VARIANT ?? 'valid'; let reads=0,escaped=0;
  const modes=['valid','malformed','identity','value','oversized','redirect','timeout','body-timeout','escaped'];
  await serve('fixture',0,async(req,res)=>{
    if(req.method==='POST' && req.url==='/mode') {
      const input=await readJson(req);
      if(!input || typeof input!=='object' || Array.isArray(input) || !('mode' in input) || typeof input.mode!=='string' || !modes.includes(input.mode) || Object.keys(input).length!==1) throw new HttpError(400,'invalid_mode','Invalid fixture mode');
      mode=input.mode; reads=0; escaped=0; return json(res,200,{mode});
    }
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
