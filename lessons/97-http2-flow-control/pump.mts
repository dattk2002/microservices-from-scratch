function untilAbort(wait: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    wait.then(
      () => { signal.removeEventListener('abort', abort); resolve(); },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(error); },
    );
    if (signal.aborted) {
      signal.removeEventListener('abort', abort);
      abort();
    }
  });
}

export async function pump(
  source: AsyncIterable<Buffer> | Iterable<Buffer>,
  write: (chunk: Buffer) => boolean,
  drain: () => Promise<void>,
  limit: number,
  signal: AbortSignal,
): Promise<number> {
  let bytes = 0;
  signal.throwIfAborted();
  for await (const chunk of source) {
    signal.throwIfAborted();
    bytes += chunk.length;
    if (bytes > limit) throw new Error('byte limit exceeded');
    if (!write(chunk)) {
      await untilAbort(drain(), signal);
      signal.throwIfAborted();
    }
  }
  signal.throwIfAborted();
  return bytes;
}
