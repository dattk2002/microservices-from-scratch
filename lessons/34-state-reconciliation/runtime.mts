import { DatabaseSync } from 'node:sqlite';
import { HttpError, json, readJson, serve } from '../../lib/http.mts';
import { apply, invalid, object, parse, parseSnapshot, snapshot } from './model.mts';

// 16 × (64 ASCII id + 256 UTF-16 units × 6 escaped bytes + envelope) < 30000.
export async function reply(url: string, method: string, body?: unknown, signal = AbortSignal.timeout(700)): Promise<unknown> {
  const response = await fetch(url, {method, signal, redirect:'error', headers:{'content-type':'application/json'}, ...(body === undefined ? {} : {body:JSON.stringify(body)})});
  if (!response.ok) throw new Error(`Dependency HTTP ${response.status}`);
  if (!response.body) throw new Error('Missing body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > 30000) throw new Error('Dependency byte budget');
      chunks.push(item.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally { await reader.cancel(); }
}
function origin(name: string): string {
  const raw = process.env[name];
  if (!raw) throw new Error(`Required ${name}`);
  const url = new URL(raw);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.origin !== raw) throw new Error(`Invalid ${name}`);
  return raw;
}
export async function main(role: 'owner' | 'projection' | 'reconciler') {
  const controls = process.env.TEACHING_CONTROLS === '1';
  const target = role === 'projection' ? '' : origin('PROJECTION_ORIGIN');
  const owner = role === 'reconciler' ? origin('OWNER_ORIGIN') : '';
  const db = role === 'reconciler' ? undefined : new DatabaseSync(process.env.DB_PATH ?? `${role}.sqlite`);
  if (db) snapshot(db);
  let failId: string | null = null;
  let running = false;
  try {
    const server = await serve(role, 3400, async (req, res) => {
      const path = req.url;
      if (req.method === 'GET' && path === '/states' && db) { json(res, 200, snapshot(db)); return; }
      if (controls && role === 'projection' && req.method === 'POST' && path === '/teaching/fail') {
        const x = object(await readJson(req));
        if (x.id !== null && (typeof x.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(x.id))) return invalid();
        failId = x.id; json(res, 200, {ok:true}); return;
      }
      if (role === 'projection' && db && req.method === 'POST' && path === '/apply') {
        const state = parse(await readJson(req));
        if (state.id === failId) throw new HttpError(503, 'injected_failure', 'Teaching failure');
        json(res, 200, {result:apply(db, state)}); return;
      }
      if (role === 'owner' && db && req.method === 'POST' && path === '/change') {
        const x = object(await readJson(req));
        const candidate = parse({id:x.id, value:x.value, version:1});
        if (x.drop !== undefined && (typeof x.drop !== 'boolean' || !controls)) return invalid();
        const old = snapshot(db).find(s => s.id === candidate.id);
        const state = parse({...candidate, version:(old?.version ?? 0) + 1});
        apply(db, state); // Commit truth BEFORE best-effort notification.
        let notification = 'dropped';
        if (x.drop !== true) {
          try {
            const result = object(await reply(`${target}/apply`, 'POST', state));
            if (typeof result.result !== 'string' || !['applied','duplicate','stale','conflict'].includes(result.result)) throw new Error('Invalid reply');
            notification = result.result;
          } catch { notification = 'failed'; }
        }
        json(res, 200, {state, notification}); return;
      }
      if (role === 'reconciler' && req.method === 'POST' && path === '/run') {
        const input = object(await readJson(req));
        if (Object.keys(input).length !== 0) return invalid(); // No caller-selected URL/SSRF.
        if (running) throw new HttpError(409, 'busy', 'One run at a time');
        running = true;
        try {
          const signal = AbortSignal.timeout(4000);
          const records = parseSnapshot(await reply(`${owner}/states`, 'GET', undefined, AbortSignal.any([signal, AbortSignal.timeout(700)])));
          const results: {id:string; result:string}[] = [];
          for (const state of records) {
            try {
              const x = object(await reply(`${target}/apply`, 'POST', state, AbortSignal.any([signal, AbortSignal.timeout(700)])));
              if (typeof x.result !== 'string' || !['applied','duplicate','stale','conflict'].includes(x.result)) throw new Error('Invalid apply result');
              results.push({id:state.id,result:x.result});
            } catch { results.push({id:state.id,result:'failed'}); }
          }
          json(res, 200, {results, complete:results.every(x => x.result !== 'failed' && x.result !== 'conflict')});
        } catch { json(res, 502, {error:'snapshot_unavailable_or_invalid'}); }
        finally { running = false; }
        return;
      }
      throw new HttpError(404, 'not_found', 'Unknown route');
    });
    server.once('close', () => db?.close());
  } catch (error) { db?.close(); throw error; }
}
