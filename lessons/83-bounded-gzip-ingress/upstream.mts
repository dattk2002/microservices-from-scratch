import {requestOnce} from './request-once.mts';
import { errorEnvelope, exactObject, isJson, parseJson, problem } from './protocol.mts';
import type { Clock, Message } from './protocol.mts';

const DEADLINE_MS = 500;
const BODY_LIMIT = 8192;

type RelayOptions = {fetcher?: typeof fetch; now?: Clock; signal?: AbortSignal};
type RelayReply =
  | {status: 201; body: {id: string; duplicate: false}}
  | {status: 200; body: {id: string; duplicate: true}}
  | {status: 409; body: ReturnType<typeof errorEnvelope<'id_conflict'>>}
  | {status: 429; body: ReturnType<typeof errorEnvelope<'capacity'>>};

export function sinkOrigin(raw: string | undefined): string {
  if (raw !== undefined && /^http:\/\/127\.0\.0\.1(?::[0-9]+)?\/?$/i.test(raw)) {
    const url = URL.parse(raw);
    if (url && url.port !== '0') return url.origin;
  }
  throw new Error('SINK_ORIGIN must be an HTTP origin on 127.0.0.1 with a usable port');
}

function knownError(value: unknown, code: string): boolean {
  return exactObject(value, 'error') && exactObject(value.error, 'code', 'message')
    && value.error.code === code && value.error.message === code;
}

function validateReply(status: number, id: string, body: unknown): RelayReply {
  if (exactObject(body, 'id', 'duplicate') && body.id === id) {
    if (status === 201 && body.duplicate === false) return {status, body: {id, duplicate: false}};
    if (status === 200 && body.duplicate === true) return {status, body: {id, duplicate: true}};
  }
  if (status === 409 && knownError(body, 'id_conflict')) return {status, body: errorEnvelope('id_conflict')};
  if (status === 429 && knownError(body, 'capacity')) return {status, body: errorEnvelope('capacity')};
  throw new Error('Unexpected sink envelope');
}

async function readReply(
  response: Response, id: string, signal: AbortSignal, checkDeadline: () => void,
): Promise<RelayReply> {
  if (!response.body) throw new Error('Missing sink body');
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  let complete = false;
  try {
    signal.addEventListener('abort', cancel, {once: true});
    checkDeadline();
    const encoding = response.headers.get('content-encoding');
    const length = response.headers.get('content-length');
    if ((response.status !== 201 && response.status !== 200 && response.status !== 409 && response.status !== 429)
      || !isJson(response.headers.get('content-type'))
      || (encoding !== null && encoding.toLowerCase() !== 'identity')
      || (length !== null && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT))) {
      throw new Error('Unexpected sink response');
    }

    const parts: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      checkDeadline();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > BODY_LIMIT) throw new Error('Sink body too large');
      if (part.value.byteLength > 0) parts.push(part.value);
    }

    complete = true;
    const reply = validateReply(response.status, id, parseJson(Buffer.concat(parts, size)));
    checkDeadline();
    return reply;
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

export async function relayMessage(origin: string, message: Message, options: RelayOptions = {}): Promise<RelayReply> {
  const now = options.now ?? (() => performance.now());
  const deadline = now() + DEADLINE_MS;
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, Math.max(0, Math.ceil(deadline - now())));
  const checkDeadline = () => {
    controller.signal.throwIfAborted();
    if (now() >= deadline) throw new Error('Sink deadline exceeded');
  };
  try {
    options.signal?.addEventListener('abort', abort, {once: true});
    if (options.signal?.aborted) abort();
    checkDeadline();
    const response = await (options.fetcher ?? requestOnce)(origin + '/messages', {
      method: 'POST',
      headers: {'content-type': 'application/json', 'accept-encoding': 'identity'},
      body: JSON.stringify(message),
      redirect: 'error',
      signal: controller.signal,
    });
    const reply = await readReply(response, message.id, controller.signal, checkDeadline);
    checkDeadline();
    return reply;
  } catch {
    throw problem(502, 'upstream_failure');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    abort();
  }
}
