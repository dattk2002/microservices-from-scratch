import { Resolver } from 'node:dns/promises';
import { request } from 'node:http';
import { Cache, CAPACITY, type Address } from './cache.mts';
import { HOSTNAME } from './wire.mts';
import { fail, health, instanceFrom, listen, portFrom, readJson, ready, send, startupError,
  type Instance } from './http.mts';

function providerValue(address: Address, port: number, signal: AbortSignal, deadline: number): Promise<Instance> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    let responded = false;
    const outbound = request({
      hostname: address, port, path: '/value', method: 'GET', agent: false,
      maxHeaderSize: 8192,
    }, (res) => {
      responded = true;
      res.on('error', failRequest);
      if (settled) {
        res.destroy();
        return;
      }
      void (async () => {
        try {
          if (res.statusCode !== 200) throw new Error('invalid provider status');
          const instance = instanceFrom(await readJson(res, signal, deadline));
          if (!instance) throw new Error('invalid provider payload');
          if (settle()) resolve(instance);
        } catch (error) {
          failRequest(error);
        }
      })();
    });
    function settle() {
      if (settled) return false;
      settled = true;
      signal.removeEventListener('abort', abort);
      return true;
    }
    function failRequest(error: unknown) {
      if (!settle()) return;
      outbound.destroy();
      reject(error);
    }
    function abort() { failRequest(signal.reason); }

    outbound.maxHeadersCount = 0;
    outbound.on('error', failRequest);
    outbound.on('close', () => {
      if (!responded) failRequest(new Error('provider closed before response'));
    });
    outbound.on('information', () => failRequest(new Error('unexpected informational response')));
    outbound.on('upgrade', (_res, socket) => {
      socket.destroy();
      failRequest(new Error('unexpected provider upgrade'));
    });
    outbound.on('connect', (_res, socket) => {
      socket.destroy();
      failRequest(new Error('unexpected provider tunnel'));
    });
    signal.addEventListener('abort', abort, { once: true });
    outbound.end();
  });
}

async function main() {
  const dnsPort = portFrom(process.env.DNS_PORT);
  const providerPort = portFrom(process.env.PROVIDER_PORT);
  const cache = new Cache(async (signal) => {
    signal.throwIfAborted();
    const resolver = new Resolver({ timeout: 1000, tries: 1 });
    resolver.setServers([`127.0.0.1:${dnsPort}`]);
    const cancel = () => resolver.cancel();
    signal.addEventListener('abort', cancel, { once: true });
    try { return await resolver.resolve4(HOSTNAME, { ttl: true }); }
    finally { signal.removeEventListener('abort', cancel); }
  });
  let active = 0;
  const service = await listen('127.0.0.1', portFrom(process.env.PORT, true), new Map([
    ['/health', ['GET', health]],
    ['/stats', ['GET', (_req, res) => send(res, 200, { ...cache.stats, active })]],
    ['/value', ['GET', async (_req, res, deadline) => {
      if (active >= CAPACITY) return fail(res, 503, 'busy');
      active++;
      const controller = new AbortController();
      const cancel = () => controller.abort();
      const timer = setTimeout(cancel, Math.max(0, Math.ceil(deadline - performance.now())));
      res.once('close', cancel);
      try {
        const address = await cache.get(controller.signal);
        if (performance.now() >= deadline) throw new Error('deadline');
        const instance = await providerValue(address, providerPort, controller.signal, deadline);
        if (controller.signal.aborted || performance.now() >= deadline) throw new Error('deadline');
        send(res, 200, { instance });
      } catch {
        if (controller.signal.aborted || performance.now() >= deadline) fail(res, 504, 'timeout');
        else fail(res, 502, 'upstream_failure');
      } finally {
        clearTimeout(timer);
        res.off('close', cancel);
        active--;
      }
    }]],
  ]));
  ready({ port: service.port }, service.close);
}

if (import.meta.main) void main().catch(startupError);
