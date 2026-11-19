import type { ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { json, readJson, serve } from '../../../lib/http.mts';
import { endpoint, exactObject, problem, validateMessage } from '../protocol.mts';
import { sinkOrigin } from '../upstream.mts';
import { errorBody } from './wire.mts';

const modes = ['ok', 'redirect', 'slow-body', 'split-deadline', 'oversize', 'at-limit', 'malformed', 'compressed',
  'wrong-conflict', 'wrong-capacity', 'wrong-id', 'wrong-media', 'ambiguous-media', 'unexpected-status'] as const;
type Mode = (typeof modes)[number];

function validMode(value: unknown): value is Mode {
  return typeof value === 'string' && modes.some(mode => mode === value);
}

function wireReply(res: ServerResponse, wire: string): void {
  res.writeHead(201, {'content-type': 'application/json'});
  // Two writes ensure the incremental check is exercised without a Content-Length.
  res.write(wire.slice(0, 4000));
  res.end(wire.slice(4000));
}

function watchPrematureClose(res: ServerResponse): Promise<boolean> {
  return new Promise(resolve => res.once('close', () => resolve(!res.writableEnded)));
}

async function main(): Promise<void> {
  const redirectOrigin = process.env.REDIRECT_TO === undefined ? undefined : sinkOrigin(process.env.REDIRECT_TO);
  let mode: Mode = 'ok';
  let hits = 0;
  let stallClosed: Promise<boolean> | undefined;

  await serve('sink-fixture', 0, endpoint(async (req, res, _acceptedAt, signal) => {
    if (req.method === 'POST' && req.url === '/mode') {
      const body = await readJson(req);
      if (!exactObject(body, 'mode') || !validMode(body.mode)) throw problem(400, 'invalid_request');
      mode = body.mode;
      json(res, 200, {mode});
      return;
    }
    if (req.method === 'GET' && req.url === '/hits') {
      json(res, 200, {hits});
      return;
    }
    if (req.method === 'GET' && req.url === '/stall-closed') {
      json(res, 200, {cancelled: (await stallClosed) ?? false});
      return;
    }
    if (req.method !== 'POST' || req.url !== '/messages') throw problem(404, 'not_found');

    hits++;
    if (req.headers['content-encoding'] !== undefined) throw problem(415, 'unsupported_encoding');
    const {id} = validateMessage(await readJson(req));
    const receipt = {id, duplicate: false};
    const wire = JSON.stringify(receipt);
    switch (mode) {
      case 'ok': return json(res, 201, receipt);
      case 'wrong-id': return json(res, 201, {id: id === 'other' ? 'wrong' : 'other', duplicate: false});
      case 'wrong-conflict': return json(res, 409, errorBody('internal_error'));
      case 'wrong-capacity': return json(res, 429, errorBody('internal_error'));
      case 'unexpected-status': return json(res, 202, receipt);
      case 'malformed': return wireReply(res, '{"id":');
      case 'at-limit': return wireReply(res, wire.padEnd(8192, ' '));
      case 'oversize':
        stallClosed = watchPrematureClose(res);
        res.writeHead(201, {'content-type': 'application/json'});
        res.write(wire);
        await delay(20, undefined, {signal});
        res.write(' '.repeat(4096));
        await delay(20, undefined, {signal});
        res.write(' '.repeat(8193 - 4096 - wire.length));
        return;
      case 'wrong-media':
        res.writeHead(201, {'content-type': 'text/plain'});
        res.end(wire);
        return;
      case 'ambiguous-media':
        res.writeHead(201, ['Content-Type', 'application/json; charset=utf-8', 'Content-Type', 'text/plain']);
        res.end(wire);
        return;
      case 'compressed':
        res.writeHead(201, {'content-type': 'application/json', 'content-encoding': 'gzip'});
        res.end(gzipSync(wire));
        return;
      case 'redirect':
        if (!redirectOrigin) throw new Error('REDIRECT_TO required');
        res.writeHead(307, {location: redirectOrigin + '/messages'});
        res.end();
        return;
      case 'slow-body':
        stallClosed = watchPrematureClose(res);
        res.writeHead(201, {'content-type': 'application/json'});
        res.write(wire);
        return;
      case 'split-deadline':
        stallClosed = watchPrematureClose(res);
        await delay(300, undefined, {signal});
        res.writeHead(201, {'content-type': 'application/json'});
        res.write(wire.slice(0, 6));
        await delay(300, undefined, {signal});
        res.end(wire.slice(6));
        return;
    }
  }));
}

if (import.meta.main) await main();
