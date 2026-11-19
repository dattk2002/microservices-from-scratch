import type { IncomingMessage, ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { HttpError, json, readJson, serve } from '../../../lib/http.mts';
import type { Snapshot, SourceId } from '../protocol.mts';

export function validSnapshot(id: SourceId): Snapshot {
  const counts = id === 'a' ? { n: 1, mean: 0 } : { n: 3, mean: 10 };
  return { id, algorithm: 'welford-v1', ...counts, m2: 0 };
}

export function sizedWire(id: SourceId, bytes: number): string {
  // These snapshots are ASCII and trailing JSON whitespace preserves the exact decoded schema.
  return JSON.stringify(validSnapshot(id)).padEnd(bytes, ' ');
}

export function compressedWire(id: SourceId): Buffer {
  // Without compression, gzip framing takes a valid 8192-byte JSON body over the wire limit.
  return gzipSync(sizedWire(id, 8192), { level: 0 });
}

async function main(): Promise<void> {
  const id = process.env.FIXTURE_ID;
  if (id !== 'a' && id !== 'b') throw new Error('Invalid FIXTURE_ID');
  const valid = validSnapshot(id);
  const invalidBodies: Record<string, unknown> = {
    null: null,
    array: [],
    primitive: true,
    extra: { ...valid, extra: true },
    'wrong-id': { ...valid, id: id === 'a' ? 'b' : 'a' },
    'wrong-algorithm': { ...valid, algorithm: 'squares' },
    'number-type': { ...valid, mean: '0' },
    'empty-inconsistent': { ...valid, n: 0, mean: 1 },
    'singleton-inconsistent': { ...valid, n: 1, m2: 1 },
    'singleton-fractional': { ...valid, n: 1, mean: 0.5, m2: 0 },
    'zero-mean-spread': { ...valid, n: 2, mean: 0, m2: 1 },
    negative: { ...valid, m2: -1 },
    'too-many': { ...valid, n: 65 },
  };
  const modes = new Set([
    ...Object.keys(invalidBodies), 'ok', 'status-snapshot', 'unexpected-code', 'error-array',
    'media', 'malformed', 'invalid-utf8', 'nonfinite', 'disconnect', 'at-limit', 'oversize',
    'slow-body', 'slow-chain', 'redirect', 'gzip',
  ]);
  let mode = 'ok';
  let received = 0;

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method === 'GET' && req.url === '/received') {
      json(res, 200, { received });
      return;
    }
    if (req.method === 'GET' && req.url === '/redirect-target') {
      received++;
      json(res, 200, {});
      return;
    }
    if (req.method === 'POST' && req.url === '/mode') {
      const input = await readJson(req);
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1
          || !('mode' in input) || typeof input.mode !== 'string' || !modes.has(input.mode)) {
        throw new HttpError(400, 'invalid_request', 'invalid_request');
      }
      mode = input.mode;
      json(res, 200, { mode });
      return;
    }
    if (req.method !== 'GET' || req.url !== '/snapshot') throw new HttpError(404, 'not_found', 'not_found');

    const selected = mode;
    if (Object.hasOwn(invalidBodies, selected)) {
      json(res, 200, invalidBodies[selected]);
      return;
    }
    switch (selected) {
      case 'status-snapshot':
        json(res, 201, valid);
        return;
      case 'unexpected-code':
        json(res, 404, { error: { code: 'internal_error', message: 'internal_error' } });
        return;
      case 'error-array':
        json(res, 404, []);
        return;
      case 'redirect': {
        const destination = process.env.REDIRECT_ORIGIN;
        if (!destination) throw new Error('REDIRECT_ORIGIN required for redirect mode');
        res.writeHead(307, { location: destination + '/redirect-target' }).end();
        return;
      }
      case 'gzip':
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        res.write(compressedWire(id));
        res.end();
        return;
      case 'slow-chain':
        await new Promise<void>(resolve => {
          const done = () => {
            clearTimeout(timer);
            res.off('close', done);
            resolve();
          };
          const timer = setTimeout(done, 300);
          res.once('close', done);
        });
        if (res.destroyed) return;
    }
    const wire = JSON.stringify(valid);
    res.writeHead(200, { 'content-type': selected === 'media' ? 'text/plain' : 'application/json' });
    switch (selected) {
      case 'slow-body':
      case 'slow-chain': {
        res.write(wire.slice(0, 1));
        const timer = setTimeout(() => res.end(wire.slice(1)), selected === 'slow-chain' ? 350 : 800);
        res.once('close', () => clearTimeout(timer));
        return;
      }
      case 'at-limit':
        res.end(sizedWire(id, 8192));
        return;
      case 'oversize': {
        const large = sizedWire(id, 8193);
        res.write(large.slice(0, 4096));
        res.end(large.slice(4096));
        return;
      }
      case 'disconnect':
        res.write('{');
        res.destroy();
        return;
      case 'malformed':
        res.end('{');
        return;
      case 'invalid-utf8':
        res.end(Buffer.from([0xff]));
        return;
      case 'nonfinite':
        res.end(wire.replace('"m2":0', '"m2":1e999'));
        return;
      default:
        res.end(wire);
    }
  };
  await serve('variance-fixture', 0, handler);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
