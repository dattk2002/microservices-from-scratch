import { gzipSync } from 'node:zlib';
import { json, readJson } from '../../../lib/http.mts';
import { exact, fail, sourceOrigins } from '../contracts.mts';
import { listen } from '../runtime.mts';

const modes = new Set([
  'ok', 'array', 'null', 'primitive', 'extra', 'wrong-id', 'wrong-algorithm',
  'wrong-total', 'count-type', 'status404', 'unexpected-code', 'status503', 'wrong-media',
  'malformed', 'invalid-utf8', 'disconnect', 'oversize', 'gzip', 'fragmented', 'slow-body', 'redirect',
]);

async function main(): Promise<void> {
  const id = process.env.FIXTURE_ID;
  if (id !== 'a' && id !== 'b') throw new Error('FIXTURE_ID must be a or b');
  const destination = process.env.REDIRECT_ORIGIN;
  const redirect = destination === undefined ? undefined : sourceOrigins(destination, 'http://127.0.0.1:1').a;
  const bins = Array<number>(11).fill(0);
  const total = id === 'a' ? 3 : 1;
  bins[id === 'a' ? 0 : 10] = total;
  const valid = { id, algorithm: 'log2-harmonic-v1', total, bins };
  const wire = JSON.stringify(valid);
  let mode = 'ok';
  let received = 0;

  await listen(`quantile-fixture-${id}`, 3078, async (req, res) => {
    if (req.url === '/stats') {
      json(res, 200, { received });
      return;
    }
    if (req.url === '/received') {
      received++;
      json(res, 200, valid);
      return;
    }
    if (req.url === '/mode' && req.method === 'POST') {
      const body = await readJson(req);
      if (!exact(body, ['mode']) || typeof body.mode !== 'string' || !modes.has(body.mode)) fail(400, 'invalid_request');
      mode = body.mode;
      json(res, 200, { mode });
      return;
    }
    if (req.url !== '/snapshot' || req.method !== 'GET') fail(404, 'not_found');

    switch (mode) {
      case 'array': json(res, 200, [valid]); return;
      case 'null': json(res, 200, null); return;
      case 'primitive': json(res, 200, 3); return;
      case 'extra': json(res, 200, { ...valid, extra: true }); return;
      case 'wrong-id': json(res, 200, { ...valid, id: id === 'a' ? 'b' : 'a' }); return;
      case 'wrong-algorithm': json(res, 200, { ...valid, algorithm: 'different' }); return;
      case 'wrong-total': json(res, 200, { ...valid, total: 0 }); return;
      case 'count-type': json(res, 200, { ...valid, bins: bins.map(String) }); return;
      case 'status404': fail(404, 'not_found');
      case 'unexpected-code': fail(404, 'internal_error');
      case 'status503': fail(503, 'internal_error');
      case 'wrong-media': res.writeHead(200, { 'content-type': 'text/plain' }).end(wire); return;
      case 'malformed': res.writeHead(200, { 'content-type': 'application/json' }).end('{'); return;
      case 'invalid-utf8': res.writeHead(200, { 'content-type': 'application/json' }).end(Buffer.from([0xff])); return;
      case 'disconnect': res.destroy(); return;
      case 'oversize': {
        // Chunked, syntactically valid JSON with an unchanged snapshot schema.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write(wire);
        res.end(' '.repeat(8193 - Buffer.byteLength(wire)));
        return;
      }
      case 'gzip': {
        const compressed = gzipSync(wire);
        res.writeHead(200, {
          'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': compressed.byteLength,
        }).end(compressed);
        return;
      }
      case 'fragmented':
      case 'slow-body': {
        const gap = mode === 'slow-body' ? 330 : 20;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write(wire.slice(0, 1));
        let timer = setTimeout(() => {
          res.write(wire.slice(1, 2));
          timer = setTimeout(() => res.end(wire.slice(2)), gap);
        }, gap);
        res.once('close', () => clearTimeout(timer));
        return;
      }
      case 'redirect': {
        if (!redirect) throw new Error('Missing redirect destination');
        res.writeHead(307, { location: redirect + '/received' }).end();
        return;
      }
      default: json(res, 200, valid);
    }
  });
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Startup failed');
    process.exitCode = 1;
  });
}
