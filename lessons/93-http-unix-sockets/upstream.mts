import { request } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { DEADLINE_MS, fields, jsonMedia, MAX_BYTES, parseValue, safeFraming } from './contract.mts';

function validHeaders(response: IncomingMessage): boolean {
  const raw = response.rawHeaders;
  const media = fields(raw, 'content-type');
  const coding = fields(raw, 'content-encoding');
  return response.statusCode === 200 && media.length === 1 && jsonMedia(media[0] ?? '')
    && (coding.length === 0 || (coding.length === 1 && coding[0]?.toLowerCase() === 'identity'))
    && safeFraming(raw);
}

export function readValue(socketPath: string, signal: AbortSignal): Promise<{ value: 'local-only' }> {
  const started = performance.now();
  const expired = () => performance.now() - started >= DEADLINE_MS;
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    let response: IncomingMessage | undefined;
    let settled = false;
    const call = request({
      socketPath, path: '/value', method: 'GET', agent: false, maxHeaderSize: MAX_BYTES,
      headers: { accept: 'application/json', host: 'localhost', connection: 'close' },
    });
    function finish(value?: { value: 'local-only' }): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      if (value && !signal.aborted && !expired()) {
        resolve(value);
      } else {
        response?.destroy();
        call.destroy();
        reject(new Error('Invalid, unavailable or incomplete upstream response'));
      }
    }
    const cancel = () => finish();
    const timer = setTimeout(cancel, Math.max(0, Math.ceil(DEADLINE_MS - (performance.now() - started))));
    call.maxHeadersCount = 0;
    call.on('error', cancel);
    call.once('close', cancel);
    call.once('upgrade', (_message, socket) => {
      socket.destroy();
      cancel();
    });
    signal.addEventListener('abort', cancel, { once: true });
    call.once('response', incoming => {
      response = incoming;
      incoming.on('error', cancel);
      incoming.once('close', cancel);
      if (expired() || !validHeaders(incoming)) return cancel();

      const chunks: Buffer[] = [];
      let size = 0;
      incoming.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES || expired()) cancel();
        else chunks.push(chunk);
      });
      incoming.once('end', () => {
        if (expired() || !incoming.complete || incoming.rawTrailers.length !== 0) return cancel();
        try {
          finish(parseValue(Buffer.concat(chunks, size)));
        } catch {
          cancel();
        }
      });
    });
    try { call.end(); } catch { cancel(); }
  });
}
