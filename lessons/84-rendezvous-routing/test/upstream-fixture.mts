import type { ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { json, readJson, serve } from '../../../lib/http.mts';
import { exact, fail, isKey, replyError, requestPath, requireEmptyBody, requireMethod } from '../protocol.mts';

const modes = [
  'exact-limit', 'wrong-member', 'wrong-key', 'wrong-value', 'extra', 'missing', 'primitive',
  'array', 'null', 'malformed', 'invalid-utf8', 'media-type', 'gzip', 'many-headers', 'late-encoding',
  'oversized-headers', 'status', 'length',
  'chunked', 'redirect', 'stall', '421-once', 'barrier',
];
const headers = { 'content-type': 'application/json' };

function wireReply(res: ServerResponse, mode: string, key: string, destination: string): void {
  const row = { member: 'b', key, value: `b/${key}` };
  const wire = JSON.stringify(row);
  switch (mode) {
    case 'exact-limit':
      res.writeHead(200, headers);
      res.end(wire.padEnd(8192));
      return;
    case 'wrong-member': json(res, 200, { ...row, member: 'a' }); return;
    case 'wrong-key': json(res, 200, { ...row, key: 'k1' }); return;
    case 'wrong-value': json(res, 200, { ...row, value: 'a/k0' }); return;
    case 'extra': json(res, 200, { ...row, unexpected: true }); return;
    case 'missing': json(res, 200, { member: 'b', key }); return;
    case 'primitive': json(res, 200, 'b/k0'); return;
    case 'array': json(res, 200, [row]); return;
    case 'null': json(res, 200, null); return;
    case 'malformed':
      res.writeHead(200, headers);
      res.end('{');
      return;
    case 'invalid-utf8':
      res.writeHead(200, headers);
      res.end(Buffer.from([0xc3, 0x28]));
      return;
    case 'media-type':
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(wire);
      return;
    case 'gzip':
      res.writeHead(200, { ...headers, 'content-encoding': 'gzip' });
      res.end(gzipSync(wire));
      return;
    case 'many-headers':
    case 'late-encoding': {
      const fields = ['content-type', 'application/json'];
      // Exceed Node's default field count and keep the complete header section below 8192 bytes.
      for (let i = 0; i < 1100; i++) fields.push('x', '1');
      if (mode === 'late-encoding') fields.push('content-encoding', 'gzip');
      res.writeHead(200, fields);
      res.end(wire);
      return;
    }
    case 'oversized-headers':
      res.writeHead(200, { ...headers, 'x-padding': 'x'.repeat(9000) });
      res.end(wire);
      return;
    case 'status': json(res, 503, row); return;
    case 'length':
      res.writeHead(200, { ...headers, 'content-length': 8193 });
      res.end(wire.padEnd(8193));
      return;
    case 'chunked':
      res.writeHead(200, headers);
      res.write(wire);
      setImmediate(() => {
        if (res.destroyed) return;
        res.write(' '.repeat(4096));
        setImmediate(() => {
          if (!res.destroyed) res.write(' '.repeat(8193 - 4096 - Buffer.byteLength(wire)));
        });
      });
      return;
    case 'redirect':
      res.writeHead(307, { location: destination + '/lookup/' + key });
      res.end();
      return;
    case 'stall':
      res.writeHead(200, headers);
      res.write(wire);
      return;
    default: throw new Error('Unexpected fixture mode');
  }
}

async function main(): Promise<void> {
  if (process.env.PROXY_FIXTURE === '1') {
    let requests = 0;
    const proxy = await serve('rendezvous-proxy-fixture', 0, (req, res) => {
      if (req.method === 'GET' && req.url === '/stats') json(res, 200, { requests });
      else {
        requests++;
        json(res, 502, { error: { code: 'proxy_contacted', message: 'proxy_contacted' } });
      }
    });
    proxy.on('connect', (_req, socket) => {
      requests++;
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    });
    return;
  }
  const destination = process.env.DESTINATION;
  if (!destination) throw new Error('Fixture needs DESTINATION');
  let mode = 'exact-limit';
  let requests = 0;
  let sent421 = false;
  let waiting: ServerResponse | undefined;
  let pending: { res: ServerResponse; key: string } | undefined;

  await serve('rendezvous-fixture', 0, async (req, res) => {
    try {
      const path = requestPath(req);
      if (path === '/stats') {
        requireMethod(req, res, 'GET');
        json(res, 200, { requests });
        return;
      }
      if (path === '/mode') {
        requireMethod(req, res, 'PUT');
        const body = await readJson(req);
        if (!exact(body, ['mode']) || typeof body.mode !== 'string' || !modes.includes(body.mode)) {
          fail(400, 'invalid_mode');
        }
        if (pending || waiting) fail(409, 'barrier_busy');
        mode = body.mode;
        sent421 = false;
        json(res, 200, { mode });
        return;
      }
      if (path === '/arrived') {
        requireMethod(req, res, 'GET');
        requireEmptyBody(req);
        if (mode !== 'barrier' || waiting) fail(409, 'barrier_busy');
        if (pending) json(res, 200, { arrived: true });
        else {
          waiting = res;
          res.once('close', () => { if (waiting === res) waiting = undefined; });
        }
        return;
      }
      if (path === '/release') {
        requireMethod(req, res, 'PUT');
        if (!exact(await readJson(req), [])) fail(400, 'invalid_request');
        if (!pending) fail(409, 'barrier_idle');
        const { res: held, key } = pending;
        pending = undefined;
        json(held, 200, { member: 'b', key, value: `b/${key}` });
        json(res, 200, { released: true });
        return;
      }
      if (!path.startsWith('/lookup/')) fail(404, 'not_found');
      requireMethod(req, res, 'GET');
      const key = path.slice('/lookup/'.length);
      if (!isKey(key)) fail(400, 'invalid_key');
      requests++;
      if (mode === '421-once') {
        json(res, sent421 ? 200 : 421, { member: 'b', key, value: `b/${key}` });
        sent421 = true;
        return;
      }
      if (mode !== 'barrier') {
        wireReply(res, mode, key, destination);
        return;
      }

      if (pending) fail(409, 'barrier_busy');
      pending = { res, key };
      res.once('close', () => { if (pending?.res === res) pending = undefined; });
      if (waiting) {
        const observer = waiting;
        waiting = undefined;
        json(observer, 200, { arrived: true });
      }
    } catch (error) {
      replyError(res, error);
    }
  });
}

if (import.meta.main) main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Startup failed');
  process.exitCode = 1;
});
