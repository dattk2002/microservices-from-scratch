import { randomBytes } from 'node:crypto';
import { readJson, json, serve } from '../../lib/http.mts';
import { aad, bytes, decrypt, encrypt, fail, objectId, record, wrapped } from './core.mts';
export async function main() {
  function key(name: string) {
    const value = process.env[name];
    if (!value || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`Explicit public demo ${name} required`);
    return Buffer.from(value, 'hex');
  }
  const keys = { v1: key('WRAP_KEY_V1'), v2: key('WRAP_KEY_V2') };
  if (keys.v1.equals(keys.v2)) throw new Error('Demo keys must differ');
  let active: 'v1' | 'v2' = 'v1'; let disableV1 = false;
  await serve('keys', 5051, async (req, res) => {
    if (req.method !== 'POST') fail(404);
    if (req.url === '/teaching/keys') {
      if (process.env.TEACHING_CONTROLS !== '1') fail(404);
      const v = record(await readJson(req));
      if (typeof v.active !== 'string' || (v.active !== 'v1' && v.active !== 'v2') || typeof v.disableV1 !== 'boolean') fail();
      if (v.active === 'v1' && v.disableV1) fail();
      active = v.active; disableV1 = v.disableV1;
      return json(res, 200, { active, disableV1 });
    }
    if (req.url !== '/wrap' && req.url !== '/unwrap') fail(404);
    const v = record(await readJson(req)); const id = objectId(v.id);
    if (req.url === '/wrap') {
      const dek = bytes(v.dek, 32);
      return json(res, 200, { kekId: active, ...encrypt(keys[active], randomBytes(12), dek, aad(id, active)) });
    }
    const w = wrapped(v.wrapped);
    if (disableV1 && w.kekId === 'v1') fail(409);
    return json(res, 200, { dek: decrypt(keys[w.kekId], w, aad(id, w.kekId)).toString('base64') });
  });
}
if (import.meta.main) await main();
