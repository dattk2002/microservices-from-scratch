import { HttpError, json, readJson, serve } from '../../lib/http.mts';
import { Store } from './store.mts';
import { action } from './model.mts';
import { input } from './protocol.mts';
const store = new Store(process.env.DB_PATH ?? 'saga.sqlite');
function endpoint(name: string): string {
  const url = new URL(process.env[name] ?? 'http://127.0.0.1:3012');
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Only simulated loopback services supported');
  return url.origin;
}
const inventory = endpoint('INVENTORY_URL');
const payment = process.env.PAYMENT_URL ? endpoint('PAYMENT_URL') : 'http://127.0.0.1:3013';
async function run(id: string) {
  for (;;) {
    const row = store.order(id);
    if (!row) throw new HttpError(404, 'not_found', 'Unknown saga');
    const op = action(String(row.state));
    if (op === 'done') return row;
    // Persist intent before remote call. Replaying the same ID is safe at the participant.
    if (op === 'release') store.set(id, 'compensating');
    try {
      const response = await fetch(`${op === 'charge' ? payment : inventory}/${op}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, refusal: row.refusal === 1 }), signal: AbortSignal.timeout(1000),
      });
      const body: unknown = await response.json();
      const expected = op === 'reserve' ? 'reserved' : op === 'charge' ? 'charged' : 'released';
      const state = typeof body === 'object' && body !== null && 'state' in body ? body.state : undefined;
      if (op === 'charge' && response.status === 402 && state === 'refused') store.set(id, 'compensating');
      else if (response.status === 200 && state === expected) store.set(id, op === 'reserve' ? 'charging' : op === 'charge' ? 'completed' : 'cancelled');
      else throw new Error('Unexpected participant response');
    } catch {
      if (op === 'release') store.set(id, 'compensation_failed');
      return store.order(id);
    }
  }
}
// One queue per database owner prevents concurrent retries racing state transitions.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work); queue = result.catch(() => undefined); return result;
}
await serve('saga', 3014, async (req, res) => {
  if (req.method === 'GET' && req.url?.startsWith('/sagas/')) {
    const row = store.order(req.url.slice(7));
    if (!row) throw new HttpError(404, 'not_found', 'Unknown saga');
    json(res, 200, row); return;
  }
  if (req.method !== 'POST' || (req.url !== '/sagas' && req.url !== '/recover')) throw new HttpError(404, 'not_found', 'Unknown route');
  const value = input(await readJson(req));
  const row = await serial(async () => {
    if (req.url === '/sagas') store.create(value.id, value.refusal);
    else {
      const existing = store.order(value.id);
      if (!existing) throw new HttpError(404, 'not_found', 'Unknown saga');
      if (existing.refusal !== Number(value.refusal)) throw new HttpError(409, 'conflict', 'Payload mismatch');
    }
    return run(value.id);
  });
  json(res, row?.state === 'completed' || row?.state === 'cancelled' ? 200 : 202, row);
});
