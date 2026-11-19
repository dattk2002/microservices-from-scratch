import {json, readJson, serve} from '../../../lib/http.mts';

async function main(): Promise<void> {
  const reply = process.env.REPLY;
  if (reply === undefined || Buffer.byteLength(reply) > 8192) throw new Error('Invalid bounded fixture reply');
  const media = process.env.MEDIA ?? 'application/json';
  const mode = process.env.MODE ?? 'retry';
  const etag = process.env.ETAG;
  let calls = 0;
  const methods: string[] = [];
  const bodies: unknown[] = [];
  await serve('single-hop-peer', 0, async (req, res) => {
    if (req.url === '/stats') { json(res, 200, {calls, methods, bodies}); return; }
    if (++calls > 16) { res.writeHead(503).end(); return; }
    methods.push(req.method ?? '');
    bodies.push(req.method === 'POST' ? await readJson(req) : null);
    const firstRetry = mode === 'retry' && calls === 1;
    const body = firstRetry ? 'unexpected' : reply;
    const headers: string[] = [];
    if (mode === 'duplicate') headers.push('content-type', media + '; note="a', 'content-type', 'b"');
    else headers.push('content-type', media);
    if (mode === 'flood') {
      for (let i = 0; i < 1100; i++) headers.push('x', 'x');
      headers.push('content-encoding', 'gzip');
    }
    if (etag) headers.push('etag', etag);
    headers.push('content-length', String(Buffer.byteLength(body)));
    res.writeHead(firstRetry ? 421 : (process.env.STATUS === '201' ? 201 : 200), headers).end(body);
  });
}
if (import.meta.main) await main();
