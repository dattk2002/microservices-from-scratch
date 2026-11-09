import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readJson, json, serve, HttpError } from '../../lib/http.mts';
import { aad, admit, bytes, decrypt, encrypt, fail, insert, load, objectId, openStore, plaintext, record, replace, wrapped } from './core.mts';
export async function main() {
  const origin = new URL(process.env.KEYS_ORIGIN ?? '');
  if (origin.protocol !== 'http:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('KEYS_ORIGIN must be an explicit HTTP origin');
  if (!process.env.DB_PATH) throw new Error('DB_PATH required');
  const db = openStore(process.env.DB_PATH);
  async function call(path: '/wrap' | '/unwrap', body: unknown, signal: AbortSignal): Promise<unknown> {
    try {
      const response = await fetch(new URL(path, origin), {method:'POST', redirect:'error', signal, headers:{'content-type':'application/json'}, body:JSON.stringify(body)});
      if (!response.ok) { await response.body?.cancel(); fail(response.status === 409 ? 409 : 502); }
      const reader = response.body?.getReader(); if (!reader) fail(502);
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const next = await reader.read(); if (next.done) break;
          size += next.value.length;
          if (size > 512) { await reader.cancel(); fail(502); }
          chunks.push(next.value);
        }
      } finally { reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch (error) { if (error instanceof HttpError) throw error; return fail(502); }
  }
  async function unwrap(id: string, w: unknown, signal: AbortSignal) {
    return bytes(record(await call('/unwrap', {id, wrapped:w}, signal)).dek, 32);
  }
  async function wrap(id: string, dek: Buffer, signal: AbortSignal) {
    const w = wrapped(await call('/wrap', {id, dek:dek.toString('base64')}, signal));
    if (!timingSafeEqual(dek, await unwrap(id, w, signal))) fail(502);
    return w;
  }
  try {
    const server = await serve('vault', 5050, async (req, res) => {
      const signal = AbortSignal.timeout(1200); // Shared by every call and body read in this operation.
      if (req.method === 'POST' && req.url === '/objects') {
        const v = record(await readJson(req)); const id = objectId(v.id); const plain = plaintext(v.plaintext);
        admit(db, id);
        const dek = randomBytes(32); const sealed = encrypt(dek, randomBytes(12), plain, aad(id));
        const w = await wrap(id, dek, signal);
        insert(db, id, sealed, w); return json(res, 201, { id, version:1 });
      }
      const match = /^\/(objects|envelopes)\/([A-Za-z0-9_-]{1,32})(\/rewrap)?$/.exec(req.url ?? '');
      if (!match) fail(404);
      const id = objectId(match[2]); const original = load(db, id);
      if (req.method === 'GET' && !match[3]) {
        if (match[1] === 'envelopes') return json(res, 200, original);
        const dek = await unwrap(id, original.wrapped, signal);
        const plain = decrypt(dek, original.data, aad(id));
        const text = new TextDecoder('utf-8', {fatal:true}).decode(plain);
        return json(res, 200, { id, plaintext:text });
      }
      if (req.method === 'POST' && match[1] === 'objects' && match[3]) {
        const body = record(await readJson(req)); if (Object.keys(body).length) fail();
        if (original.version >= 8) fail(409);
        const dek = await unwrap(id, original.wrapped, signal);
        const w = await wrap(id, dek, signal);
        replace(db, id, original.version, w);
        return json(res, 200, {id, version:original.version + 1});
      }
      fail(404);
    });
    server.once('close', () => db.close());
  } catch (error) { db.close(); throw error; }
}
if (import.meta.main) await main();
