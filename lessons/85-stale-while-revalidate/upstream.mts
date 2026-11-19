import {requestOnce} from './request-once.mts';
import { performance } from 'node:perf_hooks';
import { parseOriginValue } from './contracts.mts';
import type { OriginValue } from './contracts.mts';

const MEDIA_TOKEN = "[!#$%&'*+.^_\x60|~0-9a-z-]+";
const MEDIA_QUOTED_VALUE = /"(?:[\t\x20-\x21\x23-\x5b\x5d-\x7e\x80-\xff]|\\[\t\x20-\x7e\x80-\xff])*"/.source;
// Parse the whole field so a comma in a quoted parameter remains valid.
const JSON_MEDIA_TYPE = new RegExp(
  '^[ \\t]*application/json(?:[ \\t]*;(?:[ \\t]*' + MEDIA_TOKEN + '=(?:' + MEDIA_TOKEN + '|' + MEDIA_QUOTED_VALUE
  + '))?)*[ \\t]*$', 'i',
);


const budgetMs = 500;
const maxBytes = 8192;

export function normalizeOrigin(raw: string | undefined): string {
  if (!raw || raw.trim() !== raw || !/^http:\/\/127\.0\.0\.1(?::\d{1,5})?\/?$/.test(raw)) {
    throw new Error('ORIGIN_ORIGIN must be http://127.0.0.1 with an optional port');
  }
  const url = new URL(raw);
  if (url.port === '0') throw new Error('ORIGIN_ORIGIN must use a nonzero port');
  return url.origin;
}

export async function fetchOrigin(
  origin: string,
  shutdown: AbortSignal,
  now: () => number = () => performance.now(),
  request: typeof fetch = requestOnce,
): Promise<OriginValue> {
  const expiresAt = now() + budgetMs;
  const attempt = new AbortController();
  const signal = AbortSignal.any([shutdown, attempt.signal]);
  const timer = setTimeout(() => attempt.abort(), budgetMs);
  const checkDeadline = () => {
    signal.throwIfAborted();
    if (now() >= expiresAt) throw new Error('Origin deadline expired');
  };

  try {
    checkDeadline();
    const response = await request(new URL('/value', origin), {
      signal,
      redirect: 'error',
      headers: { 'accept-encoding': 'identity' },
    });
    checkDeadline();

    const media = response.headers.get('content-type');
    const validMedia = media !== null && JSON_MEDIA_TYPE.test(media);
    const encoding = response.headers.get('content-encoding')?.trim().toLowerCase();
    if (response.status !== 200 || !validMedia ||
        (encoding !== undefined && encoding !== 'identity') || !response.body) {
      throw new Error('Invalid origin status or representation');
    }

    const bytes = new Uint8Array(maxBytes);
    let size = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        checkDeadline();
        const chunk = await reader.read();
        checkDeadline();
        if (chunk.done) break;
        if (size + chunk.value.byteLength > maxBytes) throw new Error('Origin body too large');
        bytes.set(chunk.value, size);
        size += chunk.value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }

    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
    const snapshot = parseOriginValue(body);
    checkDeadline();
    return snapshot;
  } catch (error) {
    // Cancel the socket/body on early rejection as well as when the timer fires.
    attempt.abort();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
