import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { answer } from './wire.mts';
import { health, HttpError, instanceFrom, listen, portFrom, readJson, ready, send, startupError,
  type Instance } from './http.mts';

async function main() {
  const port = portFrom(process.env.PORT, true);
  const dnsPort = portFrom(process.env.DNS_PORT, true);
  const dns = createSocket('udp4');
  let instance: Instance = 'a';
  let dnsQueries = 0;
  let pendingSends = 0;
  try {
    const bound = once(dns, 'listening', { signal: AbortSignal.timeout(1500) });
    dns.bind(dnsPort, '127.0.0.1');
    await bound;
    const boundPort = dns.address().port;
    dns.on('error', startupError);
    dns.on('message', (packet, remote) => {
      if (remote.address !== '127.0.0.1' || pendingSends >= 64) return;
      const reply = answer(packet, instance === 'a' ? '127.0.0.1' : '127.0.0.2');
      if (!reply) return;
      dnsQueries++;
      pendingSends++;
      dns.send(reply, remote.port, remote.address, () => { pendingSends--; });
    });
    const admin = await listen('127.0.0.1', port, new Map([
      ['/health', ['GET', health]],
      ['/stats', ['GET', (_req, res) => send(res, 200, { dnsQueries, dnsPort: boundPort })]],
      ['/target', ['POST', async (req, res, deadline) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new HttpError(408, 'timeout')),
          Math.max(0, Math.ceil(deadline - performance.now())));
        try {
          const next = instanceFrom(await readJson(req, controller.signal, deadline));
          if (!next) throw new HttpError(400, 'bad_request');
          instance = next;
          send(res, 200, { instance });
        } finally { clearTimeout(timer); }
      }]],
    ]));
    ready({ port: admin.port, dnsPort: boundPort }, () => { admin.close(); dns.close(); });
  } catch (error) {
    try { dns.close(); } catch { /* Socket never bound. */ }
    throw error;
  }
}

if (import.meta.main) void main().catch(startupError);
