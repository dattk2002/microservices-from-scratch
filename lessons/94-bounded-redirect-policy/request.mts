import { request } from 'node:http';
import { maxBytes, responseLength } from './policy.mts';
import type { Hop } from './policy.mts';

export function requestHop(url: string, deadline: number, signal: AbortSignal): Promise<Hop> {
  return new Promise((resolve, reject) => {
    if (signal.aborted || performance.now() >= deadline) {
      reject(new Error('Hop cancelled or deadline reached'));
      return;
    }
    const target = new URL(url);
    const call = request(target, {
      method: 'GET',
      agent: false,
      signal,
      maxHeaderSize: maxBytes,
      setDefaultHeaders: false,
      headers: ['Host', target.host, 'Accept', 'application/json'],
    });
    call.maxHeadersCount = 0;

    const cancelDeadline = atDeadline(deadline, () => fail(new Error('Upstream deadline reached')));
    let finished = false;
    function fail(error: Error): void {
      if (finished) return;
      finished = true;
      cancelDeadline();
      reject(error);
      call.destroy();
    }
    call.on('error', fail);
    call.once('close', () => {
      fail(new Error('Upstream closed before a complete response'));
    });
    call.on('information', () => fail(new Error('Unexpected interim upstream response')));
    call.once('upgrade', (_response, socket) => {
      socket.destroy();
      fail(new Error('Unexpected protocol upgrade'));
    });

    call.once('response', response => {
      response.on('error', fail);
      let expectedLength: number | undefined;
      try {
        expectedLength = responseLength(response.rawHeaders);
      } catch {
        fail(new Error('Invalid upstream framing'));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        if (call.destroyed) return;
        size += chunk.length;
        if (size > maxBytes || performance.now() >= deadline) {
          fail(new Error('Upstream body limit or deadline reached'));
          return;
        }
        chunks.push(chunk);
      });
      response.once('end', () => {
        if (finished) return;
        if (!response.complete || response.rawTrailers.length !== 0 || signal.aborted
          || (expectedLength !== undefined && expectedLength !== size) || performance.now() >= deadline) {
          fail(new Error('Incomplete, late or unsupported upstream response'));
          return;
        }
        finished = true;
        cancelDeadline();
        resolve({status: response.statusCode ?? 0, headers: response.rawHeaders, body: Buffer.concat(chunks, size)});
      });
    });
    call.end();
  });
}


export function atDeadline(deadline: number, expire: () => void, now = () => performance.now()): () => void {
  let cancelled = false;
  let timer = setTimeout(check, Math.max(0, Math.ceil(deadline - now())));
  function check(): void {
    if (cancelled) return;
    const remaining = deadline - now();
    if (remaining > 0) timer = setTimeout(check, Math.ceil(remaining));
    else expire();
  }
  return () => { cancelled = true; clearTimeout(timer); };
}
