// Separate-process test provider. The gate makes SQL races reproducible without sleeps.
import { json, readJson, serve } from '../../../lib/http.mts';
import type { ServerResponse } from 'node:http';

if (import.meta.main) {
  let count = 0;
  let mode = 'valid';
  let gated = true;
  const pending: ServerResponse[] = [];
  const observers: { target: number; response: ServerResponse }[] = [];
  const reply = (res: ServerResponse) => {
    if (mode === 'status') json(res, 503, {});
    else if (mode === 'oversized') json(res, 200, { value: 'x'.repeat(9000) });
    else if (mode === 'invalid') json(res, 200, { id: 'pencil', priceCents: '125' });
    else if (mode === 'stream') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); }
    else if (mode === 'malformed') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{'); }
    else if (mode === 'wrong-type') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('hello'); }
    else json(res, 200, { id: 'pencil', name: 'Bút chì', priceCents: 125 });
  };
  await serve('gated-test-catalog', 0, async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/control/wait') {
      const target = Number(url.searchParams.get('count'));
      if (count >= target) json(res, 200, { count });
      else observers.push({ target, response: res });
      return;
    }
    if (url.pathname === '/control/state') { json(res, 200, { count }); return; }
    if (url.pathname === '/control/release') {
      const input = await readJson(req);
      if (typeof input === 'object' && input !== null && 'mode' in input && typeof input.mode === 'string') mode = input.mode;
      gated = false;
      for (const response of pending.splice(0)) reply(response);
      json(res, 200, { count }); return;
    }
    count++;
    for (const observer of observers.filter(observer => count >= observer.target)) json(observer.response, 200, { count });
    for (let i = observers.length - 1; i >= 0; i--) {
      const observer = observers[i];
      if (observer && count >= observer.target) observers.splice(i, 1);
    }
    if (gated) pending.push(res); else reply(res);
  });
}
