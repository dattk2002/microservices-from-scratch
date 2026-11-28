import type { Socket } from 'node:net';
import { createServer } from 'node:https';
import { TLSSocket } from 'node:tls';
import { certificate, port, tlsFiles } from './config.mts';
import { deadline, identity } from './contracts.mts';
import { bodylessRoute, errorReply, httpOptions, listen, rejectUpgrade, reply, trackConnections } from './wire.mts';

export function provider(env: NodeJS.ProcessEnv) {
  const tls = tlsFiles(env);
  const pin = certificate(env, 'GATEWAY_PIN_CERT');
  if (pin.ca) throw new Error('GATEWAY_PIN_CERT must be a leaf');
  const server = createServer({
    ...tls, ...httpOptions, requestCert: true, rejectUnauthorized: true,
    handshakeTimeout: deadline,
  });
  server.maxHeadersCount = 0;
  server.on('tlsClientError', (_error, socket) => socket.destroy());
  const authorized = (socket: Socket) =>
    socket instanceof TLSSocket &&
    identity(socket.authorized, socket.getPeerCertificate()?.fingerprint256, pin.fingerprint256) === 'gateway';
  server.on('upgrade', (request, socket) => rejectUpgrade(request, socket, authorized(request.socket)));
  server.on('connect', (request, socket) => rejectUpgrade(request, socket, authorized(request.socket)));
  const route = async (...[request, response]: Parameters<typeof bodylessRoute>) => {
    const path = await bodylessRoute(request, response);
    if (path === undefined) return;
    if (!authorized(request.socket)) {
      errorReply(response, 403, 'forbidden');
    } else if (path === '/health') {
      reply(response, 200, { status: 'ok' });
    } else {
      reply(response, 200, { value: 'trusted' });
    }
  };
  server.on('request', route).on('checkContinue', route).on('checkExpectation', route);
  return { server, stop: trackConnections(server, deadline) };
}

if (import.meta.main) {
  try {
    const env = process.env;
    const { server, stop } = provider(env);
    listen(server, port(env), stop);
  } catch {
    console.error('Invalid provider configuration');
    process.exitCode = 1;
  }
}
