import { HttpError, json, readJson, serve, numberSetting, methodNotAllowed } from '../../lib/http.mts';
import { Replica } from './core.mts';
import { configurePeers, id, persistentPath } from './protocol.mts';

export async function main() {
  const identity=process.env.REPLICA_ID;
  if(!id(identity))throw new Error('REPLICA_ID must be a, b or c');
  if((process.env.HOST??'127.0.0.1')!=='127.0.0.1')throw new Error('HOST must be 127.0.0.1');
  const peers=configurePeers(identity,process.env.PEER_ONE_ID,process.env.PEER_ONE_ORIGIN,process.env.PEER_TWO_ID,process.env.PEER_TWO_ORIGIN);
  const port=numberSetting('PORT',3067,0,65535);
  if(port!==0 && peers.some(p=>p.origin===`http://127.0.0.1:${port}`))throw new Error('Peer origin points to self');
  const index=numberSetting('BOOTSTRAP_LOG_INDEX',0,0,4);
  const term=numberSetting('BOOTSTRAP_LOG_TERM',0,0,4);
  const path=persistentPath(process.env.DB_PATH);
  const {DatabaseSync}=await import('node:sqlite');
  const db=new DatabaseSync(path);
  try {
    const replica=new Replica(db,identity,index,term);
    const server=await serve(`raft-${identity}`,3067,async(req,res)=>{
      if(req.url==='/state') {
        if(req.method!=='GET')methodNotAllowed(res,'GET');
        json(res,200,replica.state());return;
      }
      if(req.url==='/vote'||req.url==='/heartbeat'||req.url==='/campaign') {
        if(req.method!=='POST')methodNotAllowed(res,'POST');
        const body=await readJson(req);
        const result=req.url==='/vote'?replica.vote(body):req.url==='/heartbeat'?replica.heartbeat(body):await replica.campaign(body,peers);
        json(res,200,result);return;
      }
      throw new HttpError(404,'not_found','Unknown route');
    });
    server.once('close',()=>db.close());
    return server;
  } catch(error) {db.close();throw error;}
}
if(import.meta.main)await main();
