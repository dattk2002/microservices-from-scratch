import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {performance} from 'node:perf_hooks';
import {admit, BUDGET_MS, createSlot, LIMIT, statuses} from './core.mts';

function reply(res: ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'connection': 'close',
  });
  res.end(body);
}

function fail(res: ServerResponse, code: keyof typeof statuses) {
  reply(res, statuses[code], {error: {code, message: code}});
}

export function createReceiver() {
  const slot = createSlot();
  const seen = new WeakSet<IncomingMessage['socket']>();
  const server = createServer({maxHeaderSize: LIMIT, headersTimeout: 2000, requestTimeout: 2000});
  server.maxHeadersCount = 0;
  server.maxConnections = 64;
  server.on('connection', socket => {
    // A separate absolute cap also covers peers that never finish their headers.
    const timer = setTimeout(() => socket.destroy(), 2500);
    socket.once('close', () => clearTimeout(timer));
  });

  function handle(req: IncomingMessage, res: ServerResponse) {
    req.on('error', () => {});
    // All responses close the connection. Ignore already pipelined requests.
    if (seen.has(req.socket)) return;
    seen.add(req.socket);

    const admission = admit(req.method, req.url, req.rawHeaders);
    if (admission.kind === 'error') {
      if (admission.allow) res.setHeader('allow', admission.allow);
      fail(res, admission.code);
      return;
    }
    if (admission.kind === 'health') {
      reply(res, 200, {ok: true});
      return;
    }
    if (admission.kind === 'stats') {
      reply(res, 200, slot.stats());
      return;
    }
    const deadline = performance.now() + BUDGET_MS;
    const lease = slot.reserve();
    if (!lease) {
      fail(res, 'busy');
      return;
    }

    const hash = createHash('sha256');
    let bytes = 0;
    let done = false;
    const timer = setTimeout(onTimeout, BUDGET_MS);

    function finish() {
      if (done) return false;
      done = true;
      clearTimeout(timer);
      req.pause();
      req.off('data', onData);
      lease?.release();
      return true;
    }

    function onTimeout() {
      if (finish() && !res.destroyed && !req.socket.destroyed) fail(res, 'body_timeout');
    }

    function onData(chunk: Buffer) {
      if (done) return;
      lease?.consume(chunk.length);
      if (performance.now() >= deadline) {
        onTimeout();
        return;
      }
      bytes += chunk.length;
      if (bytes > admissionLength || bytes > LIMIT) {
        if (finish()) fail(res, 'body_too_large');
        return;
      }
      hash.update(chunk);
    }

    const admissionLength = admission.length;
    req.once('error', finish);
    req.once('aborted', finish);
    req.once('close', finish);
    res.once('close', finish);
    req.once('end', () => {
      if (done) return;
      if (performance.now() >= deadline) {
        onTimeout();
        return;
      }
      if (!req.complete || bytes !== admissionLength) {
        if (finish()) fail(res, 'invalid_headers');
        return;
      }
      const sha256 = hash.digest('hex');
      lease.complete();
      finish();
      reply(res, 201, {bytes, sha256});
    });

    if (admission.expect) res.writeContinue();
    req.on('data', onData);
  }

  server.on('request', handle);
  server.on('checkContinue', handle);
  server.on('checkExpectation', handle);
  return server;
}

if (import.meta.main) {
  const rawPort = process.env.PORT ?? '3000';
  const port = /^[0-9]+$/.test(rawPort) ? Number(rawPort) : NaN;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT');

  const server = createReceiver();
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    if (address && typeof address !== 'string') {
      console.log(JSON.stringify({service: 'receiver', port: address.port}));
    }
  });
}
