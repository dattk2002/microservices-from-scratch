import type { Duplex } from 'node:stream';

const OUTPUT_LIMIT = 8192;

export function boundedWriter(socket: Duplex, onFlushed: () => void) {
  const queue: Buffer[] = [];
  let queuedBytes = 0;
  let blocked = false;
  let cancelled = false;

  function send(frame: Buffer): boolean {
    if (cancelled || socket.destroyed) return false;
    if (socket.writableLength + queuedBytes + frame.length > OUTPUT_LIMIT) {
      cancel();
      socket.destroy();
      return false;
    }
    if (blocked) {
      queue.push(frame);
      queuedBytes += frame.length;
    } else {
      blocked = !socket.write(frame);
    }
    return true;
  }

  function drain(): void {
    blocked = false;
    while (!blocked && !socket.destroyed) {
      const frame = queue.shift();
      if (!frame) break;
      queuedBytes -= frame.length;
      blocked = !socket.write(frame);
    }
    if (queue.length === 0) onFlushed();
  }

  function cancel(): void {
    cancelled = true;
    socket.off('drain', drain);
    socket.off('close', cancel);
    queue.length = 0;
    queuedBytes = 0;
  }

  socket.on('drain', drain);
  socket.once('close', cancel);
  return { send, cancel, empty: () => queue.length === 0 };
}

export function closeWindow(
  expire: () => void,
  now = () => performance.now(),
  schedule = (callback: () => void, delay: number) => {
    const timer = setTimeout(callback, delay);
    return () => clearTimeout(timer);
  },
) {
  const deadline = now() + 250;
  const cancel = schedule(expire, 250);
  return { expired: () => now() >= deadline, cancel };
}


export class CloseState {
  #sent = false;
  #received = false;

  get sent(): boolean { return this.#sent; }
  get received(): boolean { return this.#received; }

  begin(): boolean {
    if (this.sent) return false;
    this.#sent = true;
    return true;
  }

  receive(): void {
    this.#received = true;
  }

  get acceptsPing(): boolean {
    return !this.received;
  }
}
