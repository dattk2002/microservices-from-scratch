import { DatabaseSync } from 'node:sqlite';
import { serve, json, readJson, methodNotAllowed } from '../../lib/http.mts';
import { Ledger, clock, catalogue, verify, fail } from './capability.mts';
export async function main(role:'issuer'|'objects') {
  const secret=process.env.CAPABILITY_SECRET;
  if(!secret || !/^[\x20-\x7e]{32,128}$/.test(secret)) throw new Error('Configure public demo CAPABILITY_SECRET (32..128 ASCII)');
  const path=process.env.DB_PATH;
  if(!path) throw new Error('Configure separate DB_PATH');
  const time=clock(process.env);
  const db=new DatabaseSync(path);
  try {
    const ledger=new Ledger(db,secret);
    const server=await serve(role,role==='issuer'?4401:4402,async(req,res)=>{
      if((req.url?.length ?? 0)>1400 || req.rawHeaders.reduce((n,h)=>n+h.length,0)>4096) fail(400);
      const url=new URL(req.url ?? '/','http://local.invalid');
      if(url.pathname==='/teaching/advance' && process.env.TEACHING_CONTROLS==='1') {
        if(req.method!=='POST') methodNotAllowed(res,'POST');
        time.advance(await readJson(req)); json(res,200,{now:time.now()}); return;
      }
      if(role==='issuer' && url.pathname==='/tickets') {
        if(req.method!=='POST') methodNotAllowed(res,'POST');
        if(url.search) fail(400);
        json(res,200,ledger.issue(await readJson(req),time.now())); return;
      }
      if(role==='objects' && /^\/objects\/[^/]+$/.test(url.pathname)) {
        if(req.method!=='GET') methodNotAllowed(res,'GET');
        const entries=[...url.searchParams];
        if(entries.length>1 || entries.some(([key])=>key!=='ticket')) fail(400);
        const ticket=url.searchParams.get('ticket');
        if(!ticket) fail(403);
        const id=url.pathname.slice('/objects/'.length);
        const rid=verify(ticket,id,time.now(),secret);
        ledger.consume(rid);
        res.setHeader('referrer-policy','no-referrer');
        json(res,200,{objectId:id,content:catalogue[id]}); return;
      }
      fail(404);
    });
    server.once('close',()=>db.close());
    return server;
  } catch(error) { db.close(); throw error; }
}
