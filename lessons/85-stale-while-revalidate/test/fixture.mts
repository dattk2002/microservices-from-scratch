import type { ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { HttpError, json, readJson, serve } from '../../../lib/http.mts';

const snapshot = '{"version":1,"value":12}';
const payloads = new Map([
  ['malformed', '{"version":1,'],
  ['primitive', '12'],
  ['array', '[1,12]'],
  ['null', 'null'],
  ['extra-field', '{"version":1,"value":12,"state":"fresh"}'],
  ['wrong-type', '{"version":{"toString":null},"value":12}'],
  ['out-of-range', '{"version":17,"value":12}'],
  ['conflict', '{"version":1,"value":13}'],
  ['regression', '{"version":0,"value":0}'],
]);
const openModes = ['oversize', 'stall', 'late-body', 'hold', 'failed-miss'];
const modes = new Set([...payloads.keys(), ...openModes, 'ok', 'redirect', 'unexpected-status',
  'semantic-error', 'wrong-media-type', 'encoded']);

function paddedSnapshot(res: ServerResponse, bytes: number): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.write(snapshot);
  // JSON permits trailing ASCII spaces, so both sizes carry the same valid snapshot.
  res.end(' '.repeat(bytes - Buffer.byteLength(snapshot)));
}

export async function main(): Promise<void> {
  const redirectOrigin = process.env.REDIRECT_ORIGIN;
  let mode = 'ok';
  let reads = 0;
  let identity = false;
  let stalled = 0;
  const held = new Set<ServerResponse>();
  const contentType = { 'content-type': 'application/json' };

  await serve('swr-fixture', 0, async (req, res) => {
    if (req.method === 'PUT' && req.url === '/mode') {
      const body = await readJson(req);
      if (typeof body !== 'object' || body === null || Array.isArray(body) ||
          Object.keys(body).length !== 1 || !Object.hasOwn(body, 'mode') ||
          !('mode' in body) || typeof body.mode !== 'string' || !modes.has(body.mode)) {
        throw new HttpError(400, 'invalid_body', 'invalid_body');
      }
      mode = body.mode;
      reads = 0;
      identity = false;
      json(res, 200, { mode });
      return;
    }

    if (req.method === 'GET' && req.url === '/stats') {
      json(res, 200, { reads, open: stalled + held.size, identity });
      return;
    }
    if (req.method === 'POST' && req.url === '/release') {
      const released = held.size;
      for (const waiting of held) paddedSnapshot(waiting, 8192);
      held.clear();
      json(res, 200, { released });
      return;
    }
    if (req.method !== 'GET' || req.url !== '/value') {
      throw new HttpError(404, 'not_found', 'not_found');
    }

    reads = Math.min(reads + 1, Number.MAX_SAFE_INTEGER);
    identity = req.headers['accept-encoding'] === 'identity';
    const payload = payloads.get(mode);
    if (payload !== undefined) {
      res.writeHead(200, contentType).end(payload);
      return;
    }

    if (mode === 'failed-miss' && reads > 1) {
      json(res, 503, { error: { code: 'unavailable', message: 'unavailable' } });
      return;
    }
    if (openModes.includes(mode) && held.size + stalled >= 16) {
      throw new HttpError(503, 'fixture_busy', 'fixture_busy');
    }
    switch (mode) {
      case 'redirect':
        if (!redirectOrigin) throw new Error('Missing redirect destination');
        res.writeHead(307, { location: new URL('/value', redirectOrigin).href }).end();
        return;
      case 'unexpected-status':
        res.writeHead(201, contentType).end(snapshot);
        return;
      case 'semantic-error':
        json(res, 409, { error: { code: 'internal_error', message: 'internal_error' } });
        return;
      case 'wrong-media-type':
        res.writeHead(200, { 'content-type': 'text/plain' }).end(snapshot);
        return;
      case 'encoded':
        res.writeHead(200, { ...contentType, 'content-encoding': 'gzip' }).end(gzipSync(snapshot));
        return;
      case 'oversize': {
        stalled++;
        let finalChunk: ReturnType<typeof setImmediate> | undefined;
        res.once('close', () => {
          stalled--;
          clearImmediate(finalChunk);
        });
        res.writeHead(200, contentType);
        res.write(snapshot);
        res.write(' '.repeat(4096));
        finalChunk = setImmediate(() => {
          res.write(' '.repeat(8193 - Buffer.byteLength(snapshot) - 4096));
        });
        return;
      }
      case 'hold':
        held.add(res);
        res.once('close', () => { held.delete(res); });
        return;
      case 'failed-miss':
      case 'stall':
        stalled++;
        res.once('close', () => { stalled--; });
        res.writeHead(200, contentType).write(snapshot);
        return;
      case 'late-body': {
        stalled++;
        let bodyTimer: ReturnType<typeof setTimeout> | undefined;
        const headersTimer = setTimeout(() => {
          res.writeHead(200, contentType).write('{"version":1,');
          bodyTimer = setTimeout(() => res.end('"value":12}'), 380);
        }, 250);
        res.once('close', () => {
          stalled--;
          clearTimeout(headersTimer);
          clearTimeout(bodyTimer);
        });
        return;
      }
      default:
        res.writeHead(200, contentType).end(snapshot);
    }
  });
}

if (import.meta.main) await main();
