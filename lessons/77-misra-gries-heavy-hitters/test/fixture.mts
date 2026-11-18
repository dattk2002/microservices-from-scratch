import type { IncomingMessage, ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { json, readJson, serve } from '../../../lib/http.mts';
import { exactFields, fail, isSource } from '../protocol.mts';

const modes = new Set([
  'ok', 'primitive', 'null', 'array', 'extra', 'identity', 'algorithm', 'slack', 'counter-extra',
  'status404', 'status503', 'internal-code', 'media', 'json', 'utf8', 'disconnect',
  'fast-body', 'slow-body', 'slow-stages', 'limit', 'oversize', 'oversize-gzip', 'redirect',
]);

async function delay(res: ServerResponse, milliseconds: number): Promise<void> {
  await new Promise<void>(resolve => {
    const done = () => {
      clearTimeout(timer);
      res.off('close', done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    res.once('close', done);
  });
}

async function main(): Promise<void> {
  const role = process.env.FIXTURE_ROLE;
  const redirect = process.env.REDIRECT_ORIGIN;
  if (role !== 'sink' && (!isSource(role) || !redirect)) throw new Error('Invalid fixture configuration');

  let mode = 'ok';
  let received = 0;
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (role === 'sink') {
      if (req.url === '/stats' && req.method === 'GET') {
        json(res, 200, { received });
      } else {
        received++;
        json(res, 200, {});
      }
      return;
    }
    if (req.url === '/mode' && req.method === 'POST') {
      const body = await readJson(req);
      if (!exactFields(body, ['mode']) || typeof body.mode !== 'string' || !modes.has(body.mode)) {
        fail(400, 'invalid_request');
      }
      mode = body.mode;
      json(res, 200, { mode });
      return;
    }
    if (req.url !== '/summary' || req.method !== 'GET') fail(404, 'not_found');

    if (mode === 'redirect') {
      res.writeHead(307, { location: redirect + '/received' });
      res.end();
      return;
    }
    if (mode === 'disconnect') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{');
      res.socket?.destroy();
      return;
    }

    const valid = {
      id: role, algorithm: 'mg3-v1', total: 2, dropped: 0, counters: [{ key: 'k10', count: 2 }],
    };
    const invalid: Record<string, unknown> = {
      primitive: 42,
      null: null,
      array: [valid],
      extra: { ...valid, extra: true },
      identity: { ...valid, id: role === 'a' ? 'b' : 'a' },
      algorithm: { ...valid, algorithm: 'mg4-v1' },
      slack: { ...valid, total: 3 },
      'counter-extra': { ...valid, counters: [{ key: 'k10', count: 2, extra: true }] },
      status404: { error: { code: 'not_found', message: 'not_found' } },
      status503: { error: { code: 'unavailable', message: 'unavailable' } },
      'internal-code': { error: { code: 'internal_error', message: 'internal_error' } },
    };
    const status = mode === 'status503' ? 503 : (mode === 'status404' || mode === 'internal-code') ? 404 : 200;
    let wire = JSON.stringify(Object.hasOwn(invalid, mode) ? invalid[mode] : valid);

    if (mode === 'oversize-gzip') {
      const encoded = gzipSync(wire);
      encoded[3] = 0x10; // FCOMMENT allows extra wire bytes without changing the decoded JSON.
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.write(encoded.subarray(0, 10));
      res.write(Buffer.alloc(8300, 'x'));
      res.end(Buffer.concat([Buffer.from([0]), encoded.subarray(10)]));
      return;
    }

    // Use legal trailing whitespace so the only defect above the limit is wire size.
    if (mode === 'limit' || mode === 'oversize') {
      const bytes = mode === 'limit' ? 8192 : 8193;
      wire += ' '.repeat(bytes - Buffer.byteLength(wire));
    }
    if (mode === 'slow-stages') {
      await delay(res, 320);
      if (res.destroyed) return;
    }
    res.writeHead(status, { 'content-type': mode === 'media' ? 'text/plain' : 'application/json' });
    if (mode === 'fast-body' || mode === 'slow-body' || mode === 'slow-stages') {
      let offset = 1;
      res.write(wire.slice(0, offset));
      if (mode === 'slow-body') {
        await delay(res, 320);
        if (res.destroyed) return;
        res.write(wire.slice(offset, offset + 1));
        offset++;
      }
      await delay(res, mode === 'fast-body' ? 75 : 320);
      if (!res.destroyed) res.end(wire.slice(offset));
    } else if (mode === 'oversize') {
      res.write(wire.slice(0, 120));
      res.end(wire.slice(120));
    } else {
      res.end(mode === 'json' ? '{' : mode === 'utf8' ? Buffer.from([0xff]) : wire);
    }
  };
  await serve('mg77-fixture', 0, handler);
}

if (import.meta.main) main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Startup failed');
  process.exitCode = 1;
});
