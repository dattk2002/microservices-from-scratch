import { request } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { DEADLINE_MS, framing, MAX_BODY, MAX_HEADERS } from './fields.mts';
import { validateReply } from './representation.mts';
import type { Range, Variant } from './accept.mts';

export function providerOrigin(input: string, gatewayPort: number): URL {
  if (!/^http:\/\/127\.0\.0\.1(?::\d+)?\/?$/i.test(input)) throw new Error('Invalid PROVIDER_ORIGIN');
  const origin = new URL(input);
  const port = Number(origin.port || '80');
  if (port === 0 || port === gatewayPort) throw new Error('PROVIDER_ORIGIN must differ from gateway origin');
  return origin;
}

async function readReply(
  res: IncomingMessage, ranges: readonly Range[], expiresAt: number,
): Promise<Variant | undefined> {
  const status = res.statusCode ?? 0;
  const { length } = framing(res.rawHeaders);
  if ((status !== 200 && status !== 406) || (length !== undefined && length > MAX_BODY)) {
    throw new Error('Unexpected upstream status or length');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res) {
    if (!Buffer.isBuffer(chunk)) throw new Error('Expected Buffer chunk');
    size += chunk.length;
    if (size > MAX_BODY || performance.now() >= expiresAt) throw new Error('Upstream limit exceeded');
    chunks.push(chunk);
  }
  if (!res.complete || res.rawTrailers.length || performance.now() >= expiresAt) {
    throw new Error('Incomplete or late upstream response');
  }
  const variant = validateReply(status, res.rawHeaders, Buffer.concat(chunks, size), ranges);
  if (performance.now() >= expiresAt) throw new Error('Upstream deadline exceeded');
  return variant;
}

export function requestGreeting(
  origin: URL, accept: string | undefined, ranges: readonly Range[], canceled: AbortSignal,
): Promise<Variant | undefined> {
  const started = performance.now();
  const expiresAt = started + DEADLINE_MS;
  const deadline = new AbortController();
  const signal = AbortSignal.any([canceled, deadline.signal]);
  const timer = setTimeout(() => deadline.abort(), DEADLINE_MS);
  const target = new URL('/greeting', origin);
  return new Promise<Variant | undefined>((resolve, reject) => {
    const call = request(target, {
      method: 'GET', agent: false, maxHeaderSize: MAX_HEADERS, signal,
      headers: { Accept: accept ?? '*/*' },
    }, res => {
      res.on('error', reject);
      void readReply(res, ranges, expiresAt).then(resolve, (error: unknown) => {
        res.destroy();
        call.destroy();
        reject(error);
      });
    });
    call.maxHeadersCount = 0;
    call.on('error', reject);
    call.on('information', () => {
      call.destroy(new Error('Unexpected informational response'));
    });
    call.on('upgrade', (_res, socket) => {
      socket.destroy();
      call.destroy();
      reject(new Error('Unexpected protocol upgrade'));
    });
    try { call.end(); }
    catch (error) {
      call.destroy();
      reject(error);
    }
  }).finally(() => clearTimeout(timer));
}
