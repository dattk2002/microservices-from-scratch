import { IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import type { HttpError } from '../../lib/http.mts';
import { parseJson, problem, validateMessage } from './protocol.mts';
import type { Clock, Encoding, Message } from './protocol.mts';

const ENCODED_LIMIT = 1024;
const DECODED_LIMIT = 512;
const DEADLINE_MS = 500;

// A post-EOF _destroy callback may report errors even with emitClose:false.
// Keep one shared guard, without retaining operation buffers, timers or closures.
function ignoreFinishedSourceError(): void {}

type BodyOptions = {now?: Clock; acceptedAt?: number; signal?: AbortSignal};

async function readBytes(
  source: Readable, encoding: Encoding, now: Clock, deadline: number, signal?: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Small output slabs let us stop promptly when the first bytes exceed the limit.
    const gunzip = encoding === 'gzip' ? createGunzip({chunkSize: 64}) : undefined;
    const output: Uint8Array[] = [];
    let encoded = 0;
    let decoded = 0;
    let settled = false;

    function finish(error?: HttpError): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onDisconnect);
      source.off('data', onInput);
      source.off('end', onInputEnd);
      source.pause();
      if (!source.listeners('error').includes(ignoreFinishedSourceError)) {
        source.on('error', ignoreFinishedSourceError);
      }
      detachInputLifecycle();
      // The HTTP endpoint closes its socket after sending the error response.
      if (error && !(source instanceof IncomingMessage)) source.destroy();

      if (gunzip) {
        gunzip.off('data', onDecoded);
        gunzip.off('end', onGzipEnd);
        gunzip.off('drain', onDrain);
        // Keep the error listener until close in case zlib already queued an error.
        gunzip.destroy();
      }

      if (error) reject(error);
      else resolve(Buffer.concat(output, decoded));
    }

    function onTimeout(): void {
      finish(problem(408, 'body_timeout'));
    }

    function onDisconnect(): void {
      finish(problem(400, 'request_aborted'));
    }

    function active(): boolean {
      if (settled) return false;
      if (signal?.aborted) onDisconnect();
      else if (now() >= deadline) onTimeout();
      return !settled;
    }

    function detachInputLifecycle(): void {
      source.off('error', onDisconnect);
      source.off('close', onInputClose);
    }

    function onInputClose(): void {
      detachInputLifecycle();
      if (!source.readableEnded) onDisconnect();
    }

    function onDecoded(chunk: Uint8Array): void {
      if (!active()) return;
      decoded += chunk.byteLength;
      if (decoded > DECODED_LIMIT) finish(problem(413, 'decoded_too_large'));
      else if (chunk.byteLength > 0) output.push(chunk);
    }

    function onInput(chunk: unknown): void {
      if (!active()) return;
      if (!(chunk instanceof Uint8Array)) {
        onDisconnect();
        return;
      }

      encoded += chunk.byteLength;
      if (encoded > ENCODED_LIMIT) {
        finish(problem(413, 'encoded_too_large'));
      } else if (!gunzip) {
        onDecoded(chunk);
      } else if (!gunzip.write(chunk)) {
        source.pause();
      }
    }

    function onInputEnd(): void {
      if (!active()) return;
      // Input teardown can complete before asynchronous gzip validation does.
      if (!source.listeners('error').includes(ignoreFinishedSourceError)) {
        source.on('error', ignoreFinishedSourceError);
      }
      detachInputLifecycle();
      if (gunzip) gunzip.end();
      else finish();
    }

    function onDrain(): void {
      if (active() && !source.readableEnded) source.resume();
    }

    function onGzipError(): void {
      if (active()) finish(problem(400, 'invalid_gzip'));
    }

    function onGzipEnd(): void {
      if (!active() || !gunzip) return;
      // Node may stop at padding after a valid member, leaving trailing bytes unread.
      if (gunzip.bytesWritten !== encoded) finish(problem(400, 'invalid_gzip'));
      else finish();
    }

    const timer = setTimeout(onTimeout, Math.max(0, Math.ceil(deadline - now())));
    gunzip?.on('error', onGzipError);
    gunzip?.once('close', () => gunzip.off('error', onGzipError));
    gunzip?.on('data', onDecoded);
    gunzip?.once('end', onGzipEnd);
    gunzip?.on('drain', onDrain);
    source.once('error', onDisconnect);
    source.once('end', onInputEnd);
    source.once('close', onInputClose);
    signal?.addEventListener('abort', onDisconnect, {once: true});
    if (!active()) return;
    const declaredLength = source instanceof IncomingMessage ? source.headers['content-length'] : undefined;
    if (typeof declaredLength === 'string' && Number(declaredLength) > ENCODED_LIMIT) {
      finish(problem(413, 'encoded_too_large'));
      return;
    }
    if (source.readableEnded) onInputEnd();
    else if (source.destroyed) onDisconnect();
    else source.on('data', onInput);
  });
}

export async function readMessage(source: Readable, encoding: Encoding, options: BodyOptions = {}): Promise<Message> {
  const now = options.now ?? (() => performance.now());
  const deadline = (options.acceptedAt ?? now()) + DEADLINE_MS;
  const bytes = await readBytes(source, encoding, now, deadline, options.signal);
  try {
    let value: unknown;
    try {
      value = parseJson(bytes);
    } catch {
      throw problem(400, 'invalid_json');
    }
    return validateMessage(value);
  } finally {
    if (options.signal?.aborted) throw problem(400, 'request_aborted');
    if (now() >= deadline) throw problem(408, 'body_timeout');
  }
}
