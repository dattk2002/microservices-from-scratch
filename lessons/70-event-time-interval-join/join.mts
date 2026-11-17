import { HttpError, json, readJson, serve, methodNotAllowed } from '../../lib/http.mts';
import { input } from './contracts.mts';
import { JoinStore } from './store.mts';

export async function main(): Promise<void> {
  if ((process.env.HOST ?? '127.0.0.1') !== '127.0.0.1') throw new Error('HOST must be 127.0.0.1');
  if (!process.env.DB_PATH) throw new Error('DB_PATH required');
  const {DatabaseSync}=await import('node:sqlite');
  const db=new DatabaseSync(process.env.DB_PATH);
  try {
    const store=new JoinStore(db,process.env.STORE_ID ?? 'lesson70');
    const server=await serve('interval-join',7070,async (req,res)=>{
      if (req.url === '/state') {
        if (req.method !== 'GET') methodNotAllowed(res,'GET');
        json(res,200,store.state()); return;
      }
      if (req.url !== '/events' && req.url !== '/watermark') throw new HttpError(404,'not_found','Route not found');
      if (req.method !== 'POST') methodNotAllowed(res,'POST');
      const body=input(req.url,await readJson(req));
      if ('id' in body) {
        const reply=store.event(body); json(res,reply.duplicate ? 200 : 201,reply);
      } else json(res,200,store.watermark(body.side,body.time));
    });
    server.once('close',()=>db.close());
  } catch (error) { db.close(); throw error; }
}
if (import.meta.main) await main();
