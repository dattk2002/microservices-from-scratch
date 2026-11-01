import { HttpError, json, numberSetting, readJson, serve } from '../../lib/http.mts';

// This deliberately small contract uses one fixed operation and a process-local replay map.
export async function main() {
  const failures = numberSetting('FAIL_FIRST', 2, 0, 100);
  const failureStatus = numberSetting('FAIL_STATUS', 503, 400, 599);
  const delayMs = numberSetting('DELAY_MS', 0, 0, 10000);
  const counts = { get: 0, unsafe: 0, protected: 0, effects: 0 };
  const replays = new Map<string, string>();
  await serve('retry-upstream', 4601, async (req, res) => {
    if (req.url === '/state' && req.method === 'GET') { json(res, 200, counts); return; }
    if (req.url === '/quote' && req.method === 'GET') {
      counts.get++;
      if (delayMs) await new Promise<void>(resolve => setTimeout(resolve, delayMs));
      json(res, counts.get <= failures ? failureStatus : 200, { priceCents: 125 }); return;
    }
    if ((req.url !== '/unsafe' && req.url !== '/protected') || req.method !== 'POST') {
      throw new HttpError(404, 'not_found', 'Unknown operation');
    }
    const body = await readJson(req);
    if (typeof body !== 'object' || body === null || Array.isArray(body) ||
        Object.keys(body).length !== 1 || !('item' in body) || body.item !== 'pencil') {
      throw new HttpError(400, 'invalid_input', 'Use exactly {"item":"pencil"}');
    }
    let result: string;
    let attempt: number;
    if (req.url === '/protected') {
      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(key) ||
          req.headersDistinct['idempotency-key']?.length !== 1) {
        throw new HttpError(400, 'invalid_key', 'One ASCII key required');
      }
      attempt = ++counts.protected;
      const previous = replays.get(key);
      if (previous !== undefined) result = previous;
      else {
        result = `reservation-${++counts.effects}`;
        replays.set(key, result); // Commit the effect and replay atomically before simulating a lost outcome.
      }
    } else {
      attempt = ++counts.unsafe;
      result = `reservation-${++counts.effects}`;
    }
    json(res, attempt <= failures ? failureStatus : 201, { reservation: result });
  });
}
if (import.meta.main) await main();
