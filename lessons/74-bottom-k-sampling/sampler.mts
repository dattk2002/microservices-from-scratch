import { constants, openSync, closeSync, fstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { HttpError, json, methodNotAllowed, readJson } from '../../lib/http.mts';
import { eventValid } from './contracts.mts';
import { SampleStore } from './store.mts';
import { listen } from './runtime.mts';

export async function main(): Promise<void> {
  const id=process.env.SAMPLE_ID;
  if (id !== 'a' && id !== 'b') throw new Error('SAMPLE_ID must be a or b');
  const path=process.env.DB_PATH;
  if (!path || !isAbsolute(path)) throw new Error('DB_PATH must be an absolute private file path');
  // SQLite inherits this file's permissions for its rollback journal.
  const file=openSync(path,constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,0o600);
  try {
    const stat=fstatSync(file);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('DB_PATH must be a private regular file (0600)');
  } finally { closeSync(file); }
  // Importing the entrypoint never loads experimental SQLite, even on Node 24.12.
  const {DatabaseSync}=await import('node:sqlite');
  const db=new DatabaseSync(path);
  try {
    const store=new SampleStore(db,id);
    const server=await listen('bottom4-sampler',7074,async (req,res)=>{
      if (req.url === '/snapshot') {
        if (req.method !== 'GET') methodNotAllowed(res,'GET');
        json(res,200,store.snapshot()); return;
      }
      if (req.url === '/events') {
        if (req.method !== 'POST') methodNotAllowed(res,'POST');
        const body=await readJson(req);
        if (!eventValid(body)) throw new HttpError(400,'invalid_request','invalid_request');
        json(res,200,store.event(body.id)); return;
      }
      throw new HttpError(404,'not_found','not_found');
    });
    server.once('close',()=>db.close());
  } catch (error) { db.close(); throw error; }
}
if (import.meta.main) await main();
