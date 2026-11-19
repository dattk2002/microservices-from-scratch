import type { ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { json, readJson, serve } from '../../../lib/http.mts';
import { fail, replyError } from '../errors.mts';
import { expectedAlgorithm, leftSlots, rightSlots, signatureWire } from './vectors.mts';

const modes = ['ok', 'id', 'algorithm', 'extra', 'primitive', 'partial-null', 'malformed',
  'status', 'oversize', 'oversize-open', 'at-limit', 'gzip', 'redirect', 'split', 'slow-body'] as const;
type Mode = (typeof modes)[number];

function validMode(body: unknown): body is {mode: Mode} {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).length === 1 && Object.hasOwn(body, 'mode') && 'mode' in body
    && typeof body.mode === 'string' && modes.some(mode => mode === body.mode);
}

function writeJsonWire(res: ServerResponse, wire: string, gap = 0, parts = 2): void {
  res.writeHead(200, {'content-type': 'application/json'});
  if (gap === 0) {
    res.end(wire);
    return;
  }
  const size = Math.ceil(wire.length / parts);
  let offset = size;
  res.write(wire.slice(0, offset));
  const timer = setInterval(() => {
    const chunk = wire.slice(offset, offset + size);
    offset += size;
    if (offset < wire.length) res.write(chunk);
    else {
      clearInterval(timer);
      res.end(chunk);
    }
  }, gap);
  res.once('close', () => clearInterval(timer));
}

function writeOpenOversize(res: ServerResponse): Promise<boolean> {
  return new Promise(resolve => {
    let sentMore = false;
    const more = setTimeout(() => {
      sentMore = true;
      res.write(' ');
    }, 300);
    const eof = setTimeout(() => res.end(), 900);
    res.once('close', () => {
      clearTimeout(more);
      clearTimeout(eof);
      resolve(!sentMore && !res.writableEnded);
    });
    res.writeHead(200, {'content-type': 'application/json'});
    res.write(signatureWire(8193));
  });
}

async function main(): Promise<void> {
  const id = process.env.FIXTURE_ID;
  if (id !== 'a' && id !== 'b') throw new Error('FIXTURE_ID must be a or b');
  const signature = {id, algorithm: expectedAlgorithm, slots: id === 'a' ? leftSlots : rightSlots};
  let mode: Mode = 'ok';
  let hits = 0;
  let oversizeCancellation: Promise<boolean> | undefined;

  await serve('minhash-fixture', 0, async (req, res) => {
    try {
      if (req.method === 'POST' && req.url === '/mode') {
        const body = await readJson(req);
        if (!validMode(body)) fail(400, 'invalid_request');
        mode = body.mode;
        json(res, 200, {mode});
        return;
      }
      if (req.method === 'GET' && req.url === '/redirect-hits') {
        json(res, 200, {hits});
        return;
      }
      if (req.method === 'GET' && req.url === '/oversize-cancellation') {
        json(res, 200, {cancelledBeforeMoreData: (await oversizeCancellation) ?? false});
        return;
      }
      if (req.method === 'GET' && req.url === '/redirect-target') {
        hits++;
        json(res, 200, signature);
        return;
      }
      if (req.method !== 'GET' || req.url !== '/signature') fail(404, 'not_found');

      switch (mode) {
        case 'ok': return json(res, 200, signature);
        case 'id': return json(res, 200, {...signature, id: id === 'a' ? 'b' : 'a'});
        case 'algorithm': return json(res, 200, {...signature, algorithm: 'incompatible'});
        case 'extra': return json(res, 200, {...signature, extra: true});
        case 'primitive': return json(res, 200, 42);
        case 'partial-null': return json(res, 200, {...signature, slots: [null, ...signature.slots.slice(1)]});
        case 'malformed': return writeJsonWire(res, '{"id":');
        case 'status': return json(res, 429, {error: {code: 'internal_error', message: 'internal_error'}});
        case 'oversize': return writeJsonWire(res, signatureWire(8193));
        case 'oversize-open':
          oversizeCancellation = writeOpenOversize(res);
          return;
        case 'at-limit': return writeJsonWire(res, signatureWire(8192));
        case 'gzip': {
          const wire = gzipSync(JSON.stringify(signature));
          res.writeHead(200, {'content-type': 'application/json', 'content-encoding': 'gzip',
            'content-length': wire.byteLength});
          res.end(wire);
          return;
        }
        case 'redirect': {
          const location = process.env.REDIRECT_TO;
          if (!location) throw new Error('REDIRECT_TO is required in redirect mode');
          res.writeHead(307, {location});
          res.end();
          return;
        }
        case 'split': return writeJsonWire(res, JSON.stringify(signature), 15);
        case 'slow-body': return writeJsonWire(res, JSON.stringify(signature), 150, 6);
      }
    } catch (error) {
      replyError(res, error);
    }
  });
}

if (import.meta.main) await main();
