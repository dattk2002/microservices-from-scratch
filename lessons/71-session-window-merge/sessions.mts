import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { HttpError, json, readJson, serve } from '../../lib/http.mts';
import { input } from './contracts.mts';
import { safe, method } from './http.mts';
import { SessionStore } from './store.mts';

export async function main(): Promise<void> {
  if ((process.env.HOST ?? '127.0.0.1') !== '127.0.0.1') throw new Error('HOST must be 127.0.0.1');
  const path=process.env.DB_PATH;
  if (!path || !isAbsolute(path)) throw new Error('DB_PATH must be an absolute private file path');
  // New files are 0600; fail closed for shared files and symlinks. The parent directory is caller-owned.
  const file=await open(path,constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,0o600);
  try {
    const info=await file.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error('DB_PATH must be a private regular file (0600)');
  } finally { await file.close(); }
  // Node24.12 emits a SQLite warning on import: keep this OUT of the inert entrypoint graph.
  const {DatabaseSync}=await import('node:sqlite');
  const db=new DatabaseSync(path);
  try {
    const store=new SessionStore(db,process.env.SOURCE_ID ?? 'lesson71');
    const server=await serve('session-windows',7072,safe(async (req,res)=>{
      if (req.url === '/state') {
        method(req,res,'GET'); json(res,200,store.state()); return;
      }
      if (req.url !== '/events' && req.url !== '/watermark') throw new HttpError(404,'not_found','not_found');
      method(req,res,'POST');
      const body=input(req.url,await readJson(req));
      if ('id' in body) {
        const reply=store.event(body); json(res,reply.duplicate ? 200 : 201,reply);
      } else json(res,200,store.watermark(body.time));
    }));
    server.once('close',()=>db.close());
  } catch (error) { db.close(); throw error; }
}
if (import.meta.main) await main();
