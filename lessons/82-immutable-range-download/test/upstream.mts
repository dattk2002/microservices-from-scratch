import type { ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { json, readJson, serve } from '../../../lib/http.mts';

const etag = '"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"';
const unknownObject = {error: {code: 'unknown_object', message: 'unknown_object'}};
const wrongError = {error: {code: 'internal_error', message: 'internal_error'}};

function binary(
  res: ServerResponse, body: string | Buffer = 'abc', headers: Record<string, string> = {}, status = 200,
): void {
  res.writeHead(status, {'content-type': 'application/octet-stream', 'content-length': '3', etag, ...headers});
  res.end(body);
}

function partial(res: ServerResponse, headers: Record<string, string> = {}): void {
  binary(res, 'bc', {'content-length': '2', 'content-range': 'bytes 1-2/3', ...headers}, 206);
}

function errorWire(res: ServerResponse, wire: string): void {
  res.writeHead(404, {'content-type': 'application/json'});
  res.write(wire); // No declared length. The downloader must count streaming bytes.
  res.end();
}

function after(res: ServerResponse, delay: number, send: () => void): void {
  const cancel = () => clearTimeout(timer);
  const timer = setTimeout(() => {
    res.off('close', cancel);
    if (!res.destroyed) send();
  }, delay);
  res.once('close', cancel);
}

function paddedErrorWire(res: ServerResponse, size: number, end: boolean): void {
  const envelope = JSON.stringify(unknownObject);
  const padding = ' '.repeat(4096);
  res.writeHead(404, {'content-type': 'application/json'});
  res.write(envelope);
  after(res, 20, () => {
    res.write(padding);
    after(res, 20, () => {
      const tail = ' '.repeat(size - envelope.length - padding.length);
      if (end) res.end(tail);
      else res.write(tail);
    });
  });
}

async function main(): Promise<void> {
  const redirectOrigin = process.env.REDIRECT_ORIGIN;
  const replies = new Map<string, (res: ServerResponse) => void>([
    ['full', res => binary(res)],
    ['valid-404-at-limit', res => paddedErrorWire(res, 8192, true)],
    ['large-404', res => paddedErrorWire(res, 8193, false)],
    ['wrong-404-code', res => json(res, 404, wrongError)],
    ['wrong-404-schema', res => json(res, 404, [unknownObject])],
    ['bad-404-json', res => errorWire(res, '{')],
    ['wrong-416-code', res => {
      res.setHeader('etag', etag);
      res.setHeader('content-range', 'bytes */3');
      json(res, 416, wrongError);
    }],
    ['bad-416-range', res => {
      res.setHeader('etag', etag);
      res.setHeader('content-range', 'bytes */2');
      json(res, 416, {error: {code: 'range_not_satisfiable', message: 'range_not_satisfiable'}});
    }],
    ['wrong-status', res => json(res, 503, unknownObject)],
    ['bad-media', res => binary(res, 'abc', {'content-type': 'text/plain'})],
    ['conflicting-media', res => {
      res.writeHead(200, [
        'content-type', 'application/octet-stream; x=y', 'content-type', 'text/html',
        'content-length', '3', 'etag', etag,
      ]);
      res.end('abc');
    }],
    ['folded-media', res => {
      res.writeHead(200, [
        'content-type', 'application/octet-stream; x="a', 'content-type', 'b"',
        'content-length', '3', 'etag', etag,
      ]);
      res.end('abc');
    }],
    ['bad-etag', res => binary(res, 'abc', {etag: 'W/' + etag})],
    ['bad-hash', res => binary(res, 'abd')],
    ['short-body', res => binary(res, 'abc', {'content-length': '4', connection: 'close'})],
    ['large-object', res => binary(res, 'a'.repeat(129), {'content-length': '129'})],
    ['gzip-object', res => {
      const compressed = gzipSync('abc');
      binary(res, compressed, {'content-encoding': 'gzip', 'content-length': String(compressed.byteLength)});
    }],
    ['bad-206-start', res => partial(res, {'content-range': 'bytes 0-1/2'})],
    ['bad-206-total', res => partial(res, {'content-range': 'bytes 1-2/4'})],
    ['redirect', res => {
      if (redirectOrigin === undefined) throw new Error('Missing redirect fixture origin');
      res.writeHead(307, {location: redirectOrigin + '/objects/o0'});
      res.end();
    }],
    ['header-stall', () => {}],
    ['body-stall', res => {
      res.writeHead(200, {'content-type': 'application/octet-stream', 'content-length': '3', etag});
      res.write('a');
    }],
    ['json-stall', res => {
      res.writeHead(404, {'content-type': 'application/json'});
      res.write('{"error":');
    }],
    ['json-envelope-stall', res => {
      res.writeHead(404, {'content-type': 'application/json'});
      res.write(JSON.stringify(unknownObject));
    }],
    ['delayed-json-envelope-stall', res => {
      after(res, 300, () => {
        res.writeHead(404, {'content-type': 'application/json'});
        res.write(JSON.stringify(unknownObject));
      });
    }],
    ['header-and-body-delay', res => {
      after(res, 300, () => {
        res.writeHead(200, {'content-type': 'application/octet-stream', 'content-length': '3', etag});
        res.write('a');
        after(res, 300, () => res.end('bc'));
      });
    }],
  ]);
  let reply = binary;
  let requests = 0;
  await serve('range-test-upstream', 0, async (req, res) => {
    if (req.method === 'POST' && req.url === '/mode') {
      const body = await readJson(req);
      const selected = typeof body === 'object' && body !== null && !Array.isArray(body)
        && Object.keys(body).length === 1 && 'mode' in body && typeof body.mode === 'string'
        ? replies.get(body.mode) : undefined;
      if (!selected) {
        json(res, 400, {error: {code: 'invalid_request', message: 'invalid_request'}});
        return;
      }
      reply = selected;
      json(res, 200, {ok: true});
      return;
    }
    if (req.method === 'GET' && req.url === '/requests') {
      json(res, 200, {requests});
      return;
    }
    if (req.method === 'GET' && req.url === '/objects/o0') {
      requests += 1;
      reply(res);
      return;
    }
    json(res, 404, unknownObject);
  });
}

if (import.meta.main) main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Startup failed');
  process.exitCode = 1;
});
