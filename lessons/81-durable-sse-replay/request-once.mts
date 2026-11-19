import {request} from 'node:http';
import {Readable} from 'node:stream';

const SINGLE_FIELDS = new Set(['content-type', 'content-encoding', 'content-length', 'etag', 'content-range']);
function ignoreLateError(): void {}

// A Response-shaped one-hop client for this lesson's fixed loopback HTTP peers.
// Unlike Fetch it never retries 421, follows redirects, decompresses, or uses a proxy.
export const requestOnce: typeof fetch = async (input, options) => {
  const target = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : undefined;
  if (!target || target.protocol !== 'http:' || target.hostname !== '127.0.0.1'
    || target.username || target.password || target.hash) throw new Error('Expected a fixed loopback URL');
  const body = options?.body;
  if (body != null && typeof body !== 'string') throw new Error('Expected an owned JSON string body');
  const fields = new Headers(options?.headers);
  if (fields.has('host') && fields.get('host') !== target.host) throw new Error('Unexpected Host');
  if (body != null) {
    const length = String(Buffer.byteLength(body));
    if (fields.has('content-length') && fields.get('content-length') !== length) throw new Error('Invalid body length');
    fields.set('content-length', length);
  }
  const headers: string[] = ['host', target.host];
  for (const [name, value] of fields) if (name !== 'host') headers.push(name, value);

  return new Promise<Response>((resolve, reject) => {
    let receivedHeaders = false;
    const call = request(target, {method: options?.method ?? 'GET', headers,
      signal: options?.signal ?? undefined, agent: false, maxHeaderSize: 8192}, response => {
      receivedHeaders = true;
      response.on('error', ignoreLateError);
      try {
        const status = response.statusCode ?? 0;
        if (status < 200 || status > 599 || (status >= 300 && status < 400)
          || status === 204 || status === 205) throw new Error('Unexpected body/status contract');
        const replyHeaders = new Headers();
        for (const [name, values] of Object.entries(response.headersDistinct)) {
          if (!values) continue;
          if (SINGLE_FIELDS.has(name) && values.length !== 1) throw new Error('Duplicate representation field');
          for (const value of values) replyHeaders.append(name, value);
        }
        // IncomingMessage supplies Buffer bytes. The built-in bridge handles backpressure,
        // cancellation and post-destroy errors without decoding the representation.
        resolve(new Response(Readable.toWeb(response, {strategy: {highWaterMark: 0}}), {status, headers: replyHeaders}));
      } catch (error) {
        response.destroy();
        call.destroy();
        reject(error);
      }
    });
    // Keep all fields within the explicit byte bound; do not silently truncate their count.
    call.maxHeadersCount = 0;
    call.on('error', ignoreLateError);
    call.once('error', reject);
    call.once('close', () => {
      call.off('error', reject);
      if (!receivedHeaders) reject(new Error('Closed before response headers'));
    });
    try { call.end(body ?? undefined); }
    catch (error) { call.destroy(); reject(error); }
  });
};
