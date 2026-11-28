import { health, instanceFrom, listen, portFrom, ready, send, startupError } from './http.mts';

async function main() {
  const instance = instanceFrom({ instance: process.env.INSTANCE });
  if (!instance) throw new Error('INSTANCE must be a or b');
  const service = await listen(instance === 'a' ? '127.0.0.1' : '127.0.0.2',
    portFrom(process.env.PORT, true), new Map([
      ['/health', ['GET', health]],
      ['/value', ['GET', (_req, res) => send(res, 200, { instance })]],
    ]));
  ready({ port: service.port }, service.close);
}

if (import.meta.main) void main().catch(startupError);
