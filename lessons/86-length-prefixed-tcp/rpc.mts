import { performance } from 'node:perf_hooks';
import type { Duplex } from 'node:stream';
import { SingleFrame } from './framing.mts';

const RPC_MS = 500;
type Options = {send?: Buffer; signal?: AbortSignal; now?: () => number};

export function exchangeFrame(
  socket: Duplex, startedAt: number, accept: (payload: Buffer) => Buffer | void,
  {send, signal, now = () => performance.now()}: Options = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = startedAt + RPC_MS;
    const input = new SingleFrame();
    let timer: NodeJS.Timeout | undefined;
    let failure: Error | undefined;
    let accepted = false;

    const fail = (error: unknown) => {
      failure ??= error instanceof Error ? error : new Error('RPC failed');
      socket.destroy();
    };
    const expire = () => {
      const remaining = deadline - now();
      if (remaining <= 0) fail(new Error('RPC deadline exceeded'));
      else timer = setTimeout(expire, Math.ceil(remaining));
    };
    const cancel = () => fail(new Error('RPC cancelled'));
    const checkDeadline = () => {
      if (now() >= deadline) throw new Error('RPC deadline exceeded');
    };

    socket.on('error', fail);
    socket.once('close', () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      try {
        if (failure) throw failure;
        if (!accepted || !socket.writableFinished) throw new Error('RPC connection closed early');
        checkDeadline();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    socket.on('data', (chunk: Buffer) => {
      try {
        checkDeadline();
        input.push(chunk);
      } catch (error) {
        fail(error);
      }
    });
    socket.once('end', () => {
      if (failure) return;
      try {
        checkDeadline();
        const reply = accept(input.finish());
        checkDeadline();
        if (reply !== undefined) socket.end(reply);
        accepted = true;
      } catch (error) {
        fail(error);
      }
    });

    signal?.addEventListener('abort', cancel, {once: true});
    if (signal?.aborted) cancel();
    else expire();
    if (send !== undefined && !socket.destroyed) socket.end(send);
  });
}
