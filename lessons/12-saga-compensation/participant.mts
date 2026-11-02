import { HttpError, json, readJson, serve } from '../../lib/http.mts';
import { Store } from './store.mts';
import { input } from './protocol.mts';
const role = process.env.ROLE ?? 'inventory';
if (role !== 'inventory' && role !== 'payment') throw new Error('Invalid ROLE');
const store = new Store(process.env.DB_PATH ?? `${role}.sqlite`);
await serve(role, role === 'inventory' ? 3012 : 3013, async (req, res) => {
  if (req.method === 'GET' && req.url === '/state') {
    json(res, 200, store.db.prepare('SELECT * FROM effects ORDER BY id').all()); return;
  }
  const operation = req.url?.slice(1) ?? ''; 
  if (req.method !== 'POST' || !(role === 'inventory' ? operation === 'reserve' || operation === 'release' : operation === 'charge')) {
    throw new HttpError(404, 'not_found', 'Unknown operation');
  }
  const { id, refusal } = input(await readJson(req));
  if (operation === 'release' && process.env.FAIL_RELEASE === '1') throw new HttpError(503, 'unavailable', 'Injected release failure');
  const state = store.effect(id, refusal, operation);
  json(res, state === 'refused' ? 402 : 200, { state });
});
