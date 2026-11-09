// Test-only process: never an application entrypoint or Playground control.
import { HttpError, json, readJson, serve } from '../../../lib/http.mts';
import { object } from '../store.mts';
const modes=['valid','primitive','partition','minimum','order','alignment','count','sum','flag','receipts','malformed','oversized','slow','redirect'] as const;
export async function main() {
  if(process.env.TEACHING_CONTROLS!=='1') throw new Error('Test controls require explicit opt-in');
  const target=process.env.REDIRECT_ORIGIN;
  const location=target ? new URL('/target',target).href : '/target';
  let mode='valid', reads=0, targets=0;
  await serve('snapshot-fixture',0,async(req,res)=> {
    if(req.method==='POST' && req.url==='/control') {
      const body=object(await readJson(req));
      if(typeof body.mode!=='string' || !modes.some(item=>item===body.mode)) throw new HttpError(400,'invalid_mode','Unknown mode');
      mode=body.mode;reads=0;targets=0;json(res,200,{ok:true});return;
    }
    if(req.method==='GET' && req.url==='/stats') {json(res,200,{reads,targets});return;}
    if(req.url==='/target') {targets++;json(res,200,{});return;}
    if(req.url!=='/state') throw new HttpError(404,'missing','Unknown route');
    reads++;
    const windows=Array.from({length:10},(_,i)=>({start:i*10,end:i*10+10,count:i===9?7:1,sum:i===9?700:100,finalized:true}));
    let state:unknown={partitions:{a:100,b:100},global:100,receipts:16,windows};
    switch(mode) {
      case 'primitive': state=null;break;
      case 'partition': state={partitions:{a:'100',b:100},global:100,receipts:16,windows};break;
      case 'minimum': state={partitions:{a:99,b:100},global:100,receipts:16,windows};break;
      case 'order': windows.reverse();break;
      case 'alignment': if(windows[0]) {windows[0].start=1;windows[0].end=11;}break;
      case 'count': if(windows[0]) windows[0].count=0;break;
      case 'sum': if(windows[0]) windows[0].sum=101;break;
      case 'flag': if(windows[0]) windows[0].finalized=false;break;
      case 'receipts': state={partitions:{a:100,b:100},global:100,receipts:15,windows};break;
      case 'malformed': res.end('{');return;
      // Valid complete identity/schema: only leading JSON whitespace breaks byte budget.
      case 'oversized': res.end(' '.repeat(8193)+JSON.stringify(state));return;
      case 'slow': res.writeHead(200,{'content-type':'application/json'});res.write(JSON.stringify(state));return;
      case 'redirect': res.writeHead(302,{location});res.end();return;
    }
    // Escape every property/string character: legal JSON, larger than canonical JSON.
    const text=JSON.stringify(state).replace(/"([^"]*)"/g,(_match:string,word:string)=>'"'+Array.from(word,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('')+'"');
    res.writeHead(200,{'content-type':'application/json'});res.end(text);
  });
}
if(import.meta.main) await main();
