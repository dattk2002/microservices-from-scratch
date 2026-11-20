import { request } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { upstreamFailure } from './digest.mts';
import type { BlobVerification, Receipt } from './digest.mts';
import { rawFieldValues } from './headers.mts';

function onlyToken(values: readonly string[], expected: string): boolean {
  return values.length === 1 && values[0]?.toLowerCase() === expected;
}

export function validateBlobHeaders(status: number | undefined, rawHeaders: readonly string[]): void {
  const field = (name: string) => rawFieldValues(rawHeaders, name);
  const coding = field('content-encoding');
  if (status !== 200
    || !onlyToken(field('content-type'), 'application/octet-stream')
    || (coding.length !== 0 && !onlyToken(coding, 'identity'))
    || !onlyToken(field('transfer-encoding'), 'chunked')
    || field('content-length').length !== 0
    || !onlyToken(field('trailer'), 'content-digest')
    || field('content-digest').length !== 0) {
    throw upstreamFailure();
  }
}

export function normalizeProducerOrigin(value: string): string {
  const authority = /^http:\/\/127\.0\.0\.1(?::([0-9]+))?\/?$/.exec(value);
  const port = authority?.[1] === undefined ? 80 : Number(authority[1]);
  if (authority?.[0] !== value || port < 1 || port > 65_535) {
    throw new Error('Invalid PRODUCER_ORIGIN');
  }
  return port === 80 ? 'http://127.0.0.1' : `http://127.0.0.1:${port}`;
}

export async function requestBlob(
  origin: string, verification: BlobVerification, signal: AbortSignal,
): Promise<Receipt> {
  try {
    return await new Promise<Receipt>((resolve, reject) => {
      verification.checkDeadline();
      if (signal.aborted) throw upstreamFailure();

      const call = request(origin + '/blob', {
        method: 'GET', agent: false, maxHeaderSize: 8192,
        headers: {te: 'trailers', connection: 'TE, close', 'accept-encoding': 'identity'},
      });
      call.maxHeadersCount = 0;

      let peer: IncomingMessage | undefined;
      let timer: NodeJS.Timeout | undefined;
      let settled = false;
      const settle = (receipt?: Receipt) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', fail);
        if (receipt !== undefined) {
          resolve(receipt);
        } else {
          peer?.destroy();
          call.destroy();
          reject(upstreamFailure());
        }
      };
      const fail = () => settle();

      // Keep error handlers attached through socket teardown and its late events.
      call.on('error', fail);
      call.once('close', fail);
      call.once('upgrade', (_response, socket) => {
        socket.destroy();
        fail();
      });

      call.once('response', response => {
        peer = response;
        response.on('error', fail);
        if (settled) {
          response.destroy();
          return;
        }
        try {
          verification.checkDeadline();
          validateBlobHeaders(response.statusCode, response.rawHeaders);
        } catch {
          fail();
          return;
        }

        response.once('aborted', fail);
        response.once('close', fail);
        response.once('end', () => {
          if (settled) return;
          try {
            // 'end' is the logical HTTP message boundary. TCP may still be open.
            if (!response.complete) throw upstreamFailure();
            settle(verification.finish(true, response.rawTrailers));
          } catch {
            fail();
          }
        });
        response.on('data', (chunk: Buffer) => {
          if (settled) return;
          try {
            verification.add(chunk);
          } catch {
            fail();
          }
        });
      });

      try {
        signal.addEventListener('abort', fail, {once: true});
        verification.checkDeadline();
        timer = setTimeout(fail, Math.ceil(verification.remainingMs()));
        call.end();
      } catch {
        fail();
      }
    });
  } catch {
    throw upstreamFailure();
  }
}
