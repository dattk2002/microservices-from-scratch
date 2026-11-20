import { request } from 'node:http';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { performance } from 'node:perf_hooks';
import { parsePeerBody } from './contracts.mts';
import type { PeerResult } from './contracts.mts';
import {
  HEADER_BYTES, HTTP_MS, checkDeadline, checkJsonFraming, checkTrailers, decodeJson, ignoreLateError,
  readBytes, requireEmpty204, validJsonHeaders, withDeadline,
} from './http.mts';

async function readPeer(
  response: IncomingMessage, after: number, signal: AbortSignal, expiresAt: number,
): Promise<PeerResult> {
  checkDeadline(expiresAt, signal);
  const status = response.statusCode ?? 0;
  if (status === 204) {
    requireEmpty204(response);
    await readBytes(response, signal, expiresAt, 0);
    return { status };
  }
  if ((status !== 200 && status !== 409 && status !== 503) || !validJsonHeaders(response)) {
    throw new Error('Unexpected origin status or representation');
  }
  checkJsonFraming(response);
  const bytes = await readBytes(response, signal, expiresAt);
  checkTrailers(response);
  return parsePeerBody(status, decodeJson(bytes), after);
}

export async function requestChanges(origin: URL, after: number, caller: AbortSignal): Promise<PeerResult> {
  const expiresAt = performance.now() + HTTP_MS;
  let call: ClientRequest | undefined;
  let incoming: IncomingMessage | undefined;
  try {
    return await withDeadline(expiresAt, caller, async signal => {
      checkDeadline(expiresAt, signal);
      const target = new URL(`/changes?after=${after}`, origin);
      const result = await new Promise<PeerResult>((resolve, reject) => {
        const requestHandle = request(target, {
          method: 'GET', agent: false, maxHeaderSize: HEADER_BYTES, signal,
          headers: { 'accept-encoding': 'identity', 'connection': 'close' },
        }, response => {
          incoming = response;
          response.on('error', ignoreLateError);
          void readPeer(response, after, signal, expiresAt).then(resolve, reject);
        });
        call = requestHandle;
        requestHandle.maxHeadersCount = 0;
        requestHandle.on('error', reject);
        requestHandle.once('close', () => {
          if (incoming === undefined) reject(new Error('Origin closed before response headers'));
        });
        requestHandle.on('information', () => reject(new Error('Unexpected informational status')));
        requestHandle.end();
      });
      checkDeadline(expiresAt, signal);
      return result;
    });
  } finally {
    incoming?.destroy();
    call?.destroy();
  }
}
