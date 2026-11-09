// Test-only independent upstream: strict controls reuse one process for failure variants.
import { serve,json,HttpError } from '../../../lib/http.mts';
import { control } from '../transport.mts';
import { object } from '../policy.mts';
export async function main() {
  let mode='same',calls=0; let last:Record<string,unknown>|undefined;
  const timers=new Set<ReturnType<typeof setTimeout>>();
  const target=process.env.TARGET_ORIGIN ?? '';
  const server=await serve('fixture',0,async(req,res)=>{
    if(req.url==='/state') {json(res,200,{calls,last});return;}
    if(req.url==='/configure' && req.method==='POST') {
      const body=await control(req);
      if(!object(body) || Object.keys(body).length!==1 || typeof body.mode!=='string' || !['same','wrong','oversized','slow','redirect','unavailable','maximum'].includes(body.mode)) throw new HttpError(400,'bad','Invalid fixture mode');
      mode=body.mode;calls=0;last=undefined;json(res,200,{});return;
    }
    const match=/^\/products\/([A-Za-z0-9_-]{1,32})$/.exec(req.url ?? '');
    if(!match) throw new HttpError(400,'bad','Product required');
    calls++;last={path:req.url,method:req.method,authorization:req.headers.authorization ?? null,cookie:req.headers.cookie ?? null,context:req.headers['x-signed-context'] ?? null,accept:req.headers.accept,body:req.headers['content-length'] ?? null};
    if(mode==='redirect') {res.writeHead(302,{location:`${target}/products/${match[1]}`});res.end();return;}
    if(mode==='unavailable') {json(res,503,{error:'down'});return;}
    if(mode==='slow') {
      await new Promise<void>(resolve=>{const timer=setTimeout(()=>{timers.delete(timer);resolve();},1200);timers.add(timer);res.once('close',()=>{clearTimeout(timer);timers.delete(timer);resolve();});});
    }
    if(res.destroyed) return;
    const value={id:match[1],price:mode==='maximum'?Number.MAX_SAFE_INTEGER:10000,currency:mode==='wrong'?'USD':'VND'};
    // Whitespace leaves schema and identity intact; only byte budget is violated.
    if(mode==='oversized') {res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value)+' '.repeat(513));return;}
    if(mode==='maximum') {
      const escaped=[...match[1]!].map(char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0')).join('');
      res.writeHead(200,{'content-type':'application/json'});res.end(`{"id":"${escaped}","price":9007199254740991,"currency":"VND"}`);return;
    }
    json(res,200,value);
  });
  process.once('SIGTERM',()=>{for(const timer of timers) clearTimeout(timer);server.closeAllConnections();});
}
if(import.meta.main) await main();
