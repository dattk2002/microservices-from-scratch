import { setImmediate as nextTurn } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { json, readJson, serve } from '../../../lib/http.mts';
import { exactKeys } from '../contracts.mts';

const third = 'id: 3\nevent: item\ndata: {"id":"c","text":"Third"}\n\n';
const sseHeaders = {'content-type': 'text/event-stream; charset=utf-8'};
const jsonHeaders = {'content-type': 'application/json'};
const conflict = '{"error":{"code":"cursor_ahead","message":"cursor_ahead"}}';
const invalidOrPaddedConflicts = new Map([
  ['409-null', 'null'],
  ['409-array', '[' + conflict + ']'],
  ['409-primitive', '3'],
  ['409-extra', '{"error":{"code":"cursor_ahead","message":"cursor_ahead","extra":0}}'],
  ['409-unexpected', '{"error":{"code":"internal_error","message":"internal_error"}}'],
  ['409-wrong-message', '{"error":{"code":"cursor_ahead","message":"wrong"}}'],
  ['409-exact-cap', conflict.padEnd(8192)],
]);
const modes = new Set([
  'normal', 'split', 'wrong-type', 'conflicting-type', 'folded-malformed-type', 'gzip', 'bad-utf8', 'malformed', 'gap',
  'duplicate-id', 'cut', 'stall', 'redirect', 'oversize-sse', 'exact-cap-sse', '409-gzip',
  '409-conflicting-type', '409-stall', '409-oversize', ...invalidOrPaddedConflicts.keys(),
]);

function sseOfSize(bytes: number): string {
  return third + ':' + ' '.repeat(bytes - third.length - 2) + '\n';
}

async function main(): Promise<void> {
  const destination = process.env.REDIRECT_TO;
  let mode = 'normal';
  let hits = 0;
  await serve('sse-upstream-test', 8083, async (req, res) => {
    if (req.method === 'POST' && req.url === '/mode') {
      const body = await readJson(req);
      if (!exactKeys(body, ['mode']) || typeof body.mode !== 'string' || !modes.has(body.mode)) {
        json(res, 400, {error: {code: 'invalid_request', message: 'invalid_request'}});
        return;
      }
      mode = body.mode;
      json(res, 200, {mode});
      return;
    }
    if (req.method === 'GET' && req.url === '/hits') {
      json(res, 200, {hits});
      return;
    }
    if (req.method === 'GET' && req.url === '/redirect-target') {
      hits++;
      res.writeHead(200, sseHeaders).end(third);
      return;
    }
    if (req.method !== 'GET' || req.url !== '/events' || req.headers['last-event-id'] !== '2') {
      json(res, 400, {error: {code: 'unexpected_request', message: 'unexpected_request'}});
      return;
    }

    const conflictWire = invalidOrPaddedConflicts.get(mode);
    if (conflictWire !== undefined) {
      res.writeHead(409, jsonHeaders).end(conflictWire);
      return;
    }

    switch (mode) {
      case 'split': {
        const wire = Buffer.from(': café\r\nid: 3\r\nevent: item\r\ndata: {"id":"c",\r\n'
          + 'data: "text":"Third"}\r\n\r\nid: 4\nevent: item\ndata: incomplete\n');
        res.writeHead(200, sseHeaders);
        res.write(wire.subarray(0, 6)); // Middle of é in UTF-8.
        await nextTurn();
        res.write(wire.subarray(6, 8)); // Between CR and LF.
        await nextTurn();
        res.end(wire.subarray(8));
        return;
      }
      case 'wrong-type':
        res.writeHead(200, {'content-type': 'text/plain'}).end(third);
        return;
      case 'folded-malformed-type':
        res.writeHead(200, ['content-type', 'text/event-stream; note="a', 'content-type', 'b"']).end(third);
        break;
      case 'conflicting-type':
        res.writeHead(200, ['content-type', 'text/event-stream; charset=utf-8',
          'content-type', 'application/json']).end(third);
        return;
      case '409-conflicting-type':
        res.writeHead(409, {'content-type': 'application/json; charset=utf-8, text/event-stream'}).end(conflict);
        return;
      case 'gzip':
        res.writeHead(200, {...sseHeaders, 'content-encoding': 'gzip'}).end(gzipSync(third));
        return;
      case '409-gzip':
        res.writeHead(409, {...jsonHeaders, 'content-encoding': 'gzip'}).end(gzipSync(conflict));
        return;
      case 'bad-utf8':
        res.writeHead(200, sseHeaders).end(Buffer.concat([Buffer.from(third), Buffer.of(0xc3)]));
        return;
      case 'malformed':
        res.writeHead(200, sseHeaders).end(third + 'id: 4\nevent: item\ndata: not JSON\n\n');
        return;
      case 'gap':
        res.writeHead(200, sseHeaders).end(third + 'id: 5\nevent: item\ndata: {"id":"e","text":"Fifth"}\n\n');
        return;
      case 'duplicate-id':
        res.writeHead(200, sseHeaders).end(third + 'id: 4\nevent: item\ndata: {"id":"c","text":"Fourth"}\n\n');
        return;
      case 'cut':
        res.writeHead(200, {...sseHeaders, 'content-length': third.length + 10});
        res.write(third, () => res.destroy());
        return;
      case 'stall':
        res.writeHead(200, sseHeaders);
        res.write(third);
        // Leave the body open. The reader's deadline or fixture shutdown closes the connection.
        return;
      case '409-stall':
        res.writeHead(409, jsonHeaders);
        res.write(conflict);
        return;
      case '409-oversize':
        res.writeHead(409, jsonHeaders);
        res.write(conflict);
        await nextTurn();
        res.write(' '.repeat(4096));
        await nextTurn();
        // Valid JSON with 8193 bytes of wire data. Keep the body open after crossing the cap.
        res.write(' '.repeat(8193 - conflict.length - 4096));
        return;
      case 'redirect':
        if (!destination) throw new Error('Redirect target missing');
        res.writeHead(307, {location: destination}).end();
        return;
      case 'exact-cap-sse':
      case 'oversize-sse':
        res.writeHead(200, sseHeaders).end(sseOfSize(mode === 'exact-cap-sse' ? 8192 : 8193));
        return;
      default:
        res.writeHead(200, sseHeaders).end(third);
    }
  });
}

if (import.meta.main) await main();
