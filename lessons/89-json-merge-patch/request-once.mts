import { request } from 'node:http';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { BODY_MS, etag, fail, PATCH_MEDIA, peerReply } from './contract.mts';
import { fields, ignoreLateError, parseBody, readBytes, requireJsonHeaders, requireSafeTrailers } from './http.mts';
import type { Call } from './http.mts';

export async function requestProfile(origin: URL, call: Call, caller: AbortSignal) {
  const started = performance.now();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), BODY_MS);
  try {
    const signal = AbortSignal.any([deadline.signal, caller]);
    signal.throwIfAborted();
    const headers: Record<string, string> = { accept: 'application/json', 'accept-encoding': 'identity' };
    if (call.method === 'PATCH') {
      headers['if-match'] = etag(call.version);
      headers['content-type'] = PATCH_MEDIA;
      headers['content-length'] = String(call.bytes.length);
    }

    const { outgoing, incoming } = await new Promise<{ outgoing: ClientRequest; incoming: IncomingMessage }>((resolve, reject) => {
      const outgoing = request(origin, {
        path: '/profile', method: call.method, headers, agent: false, maxHeaderSize: 8192, signal,
      }, incoming => {
        incoming.on('error', ignoreLateError);
        resolve({ outgoing, incoming });
      });
      const failed = (error: unknown) => { outgoing.destroy(); reject(error); };
      outgoing.maxHeadersCount = 0;
      outgoing.on('error', failed);
      outgoing.once('close', () => reject(new Error('Peer closed before headers')));
      try { outgoing.end(call.method === 'PATCH' ? call.bytes : undefined); }
      catch (error) { failed(error); }
    });
    try {
      requireJsonHeaders(incoming.rawHeaders, 'json');
      const tags = fields(incoming.rawHeaders, 'etag');
      if (tags.length > 1) fail(502, 'upstream_failure');
      const bytes = await readBytes(incoming, started);
      if (performance.now() - started >= BODY_MS) fail(502, 'upstream_failure');
      signal.throwIfAborted();
      requireSafeTrailers(incoming.rawTrailers, 'json');
      return peerReply(incoming.statusCode ?? 0, tags[0], parseBody(bytes),
        call.method === 'PATCH' ? call.version : undefined);
    } finally {
      incoming.destroy();
      outgoing.destroy();
    }
  } finally {
    clearTimeout(timer);
  }
}
