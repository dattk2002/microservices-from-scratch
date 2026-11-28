import { X509Certificate } from 'node:crypto';
import { createServer } from 'node:http';
import { request } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { port, tlsFiles } from './config.mts';
import { deadline, endpoint, limit, parseValue } from './contracts.mts';
import { bodylessRoute, errorReply, httpOptions, listen, rejectUpgrade, reply, representation, validJsonMedia } from './wire.mts';

function upstream(origin: URL, tls: ReturnType<typeof tlsFiles>, signal: AbortSignal) {
  const end = performance.now() + deadline;
  return new Promise<ReturnType<typeof parseValue>>((resolve, reject) => {
    const call = request(new URL('/value', origin), {
      ...tls, servername: 'provider.local', rejectUnauthorized: true, agent: false,
      method: 'GET', maxHeaderSize: limit, signal,
      checkServerIdentity(host, peer) {
        const error = checkServerIdentity(host, peer);
        if (error) return error;
        if (new X509Certificate(peer.raw).checkHost('provider.local', { subject: 'never', wildcards: false }) === undefined) {
          return new Error('Missing provider.local DNS SAN');
        }
      },
    });
    call.maxHeadersCount = 0;
    const timer = setTimeout(() => fail(new Error('Upstream deadline')), Math.max(0, end - performance.now()));
    function fail(error: unknown) {
      clearTimeout(timer);
      call.destroy();
      reject(error);
    }

    call.on('error', fail);
    call.on('information', () => fail(new Error('Unexpected informational response')));
    call.on('upgrade', (_response, socket) => {
      socket.destroy();
      fail(new Error('Unexpected upgrade'));
    });
    call.on('response', async (response) => {
      try {
        const fields = representation(response.rawHeaders);
        if (response.statusCode !== 200 || !validJsonMedia(fields.get('content-type')) ||
            fields.has('content-encoding') || Number(fields.get('content-length')) > limit) {
          throw new Error('Unexpected upstream response');
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of response) {
          if (!Buffer.isBuffer(chunk)) throw new Error('Unexpected decoded response');
          size += chunk.length;
          if (size > limit || performance.now() >= end) throw new Error('Upstream bounds exceeded');
          chunks.push(chunk);
        }
        if (!response.complete || response.rawTrailers.length) throw new Error('Incomplete or ambiguous response');
        const value = parseValue(Buffer.concat(chunks, size));
        if (performance.now() >= end || signal.aborted) throw new Error('Upstream deadline or cancellation');
        clearTimeout(timer);
        resolve(value);
      } catch (error) {
        fail(error);
      }
    });
    call.end();
  });
}

export function gateway(env: NodeJS.ProcessEnv) {
  const origin = endpoint(env.PROVIDER_ORIGIN);
  const tls = tlsFiles(env);
  let active = 0;
  const server = createServer(httpOptions);
  server.maxHeadersCount = 0;
  server.on('upgrade', (request, socket) => rejectUpgrade(request, socket));
  server.on('connect', (request, socket) => rejectUpgrade(request, socket));
  const route = async (...[request, response]: Parameters<typeof bodylessRoute>) => {
    const path = await bodylessRoute(request, response);
    if (path === '/health') {
      reply(response, 200, { status: 'ok' });
      return;
    }
    if (path !== '/value' || response.destroyed) return;
    if (active >= 8) {
      errorReply(response, 503, 'busy');
      return;
    }
    active++;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    response.once('close', cancel);
    try {
      reply(response, 200, await upstream(origin, tls, controller.signal));
    } catch {
      if (!controller.signal.aborted) errorReply(response, 502, 'upstream_failure');
    } finally {
      response.off('close', cancel);
      active--;
    }
  };
  server.on('request', route).on('checkContinue', route).on('checkExpectation', route);
  return server;
}

if (import.meta.main) {
  try {
    const env = process.env;
    listen(gateway(env), port(env));
  } catch {
    console.error('Invalid gateway configuration');
    process.exitCode = 1;
  }
}
