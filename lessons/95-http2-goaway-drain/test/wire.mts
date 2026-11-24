import assert from 'node:assert/strict';
import { Socket } from 'node:net';
import type { TestContext } from 'node:test';
import { within } from './support.mts';

const preface = Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n');
export const DATA = 0;
export const HEADERS = 1;
const SETTINGS = 4;
const PING = 6;
export const GOAWAY = 7;

export function frame(type: number, flags: number, id: number, body: Buffer) {
  const header = Buffer.alloc(9);
  header.writeUIntBE(body.length, 0, 3);
  header[3] = type;
  header[4] = flags;
  header.writeUInt32BE(id, 5);
  return Buffer.concat([header, body]);
}

type Frame = { type: number; flags: number; id: number; body: Buffer };

export async function wire(t: TestContext, port: number, { window, partial = false }: {
  window?: number; partial?: boolean;
} = {}) {
  const socket = new Socket();
  t.after(() => { socket.destroy(); });
  const closed = new Promise<number>((resolve) => socket.once('close', () => resolve(performance.now())));
  const frames: Frame[] = [];
  let pending = Buffer.alloc(0);
  let bytes = 0;
  let failure: Error | undefined;
  let wake = () => {};
  socket.on('error', (error) => { failure = error; });
  socket.once('close', () => wake());
  socket.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 8192) {
      socket.destroy(new Error('Worker wire fixture exceeded 8192 bytes'));
      return;
    }
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 9) {
      const length = pending.readUIntBE(0, 3);
      if (pending.length < 9 + length) break;
      const item = {
        type: pending.readUInt8(3), flags: pending.readUInt8(4),
        id: pending.readUInt32BE(5) & 0x7fff_ffff, body: pending.subarray(9, 9 + length),
      };
      frames.push(item);
      pending = pending.subarray(9 + length);
      if (!partial && item.type === SETTINGS && item.flags === 0 && !socket.destroyed) {
        socket.write(frame(SETTINGS, 1, 0, Buffer.alloc(0)));
      }
    }
    wake();
  });

  async function until(match: (item: Frame) => boolean, label: string) {
    return within((async () => {
      for (;;) {
        const found = frames.find(match);
        if (found) return found;
        if (socket.destroyed) throw failure ?? new Error(`Socket closed before ${label}`);
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    })(), label);
  }

  await within(new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.connect(port, '127.0.0.1', resolve);
  }), 'raw worker TCP connect');
  const settings = Buffer.alloc(window === undefined ? 0 : 6);
  if (window !== undefined) {
    settings.writeUInt16BE(4); // SETTINGS_INITIAL_WINDOW_SIZE
    settings.writeUInt32BE(window, 2);
  }
  socket.write(partial ? preface.subarray(0, -1) : Buffer.concat([preface, frame(SETTINGS, 0, 0, settings)]));
  await until((item) => item.type === SETTINGS && item.flags === 0, 'worker SETTINGS');

  function work(id: number) {
    const authority = Buffer.from(`127.0.0.1:${port}`);
    // HPACK static names/values, without Huffman coding or dynamic table entries.
    const block = Buffer.concat([
      Buffer.from([0x82, 0x86, 0x04, 5]), Buffer.from('/work'),
      Buffer.from([0x01, authority.length]), authority,
    ]);
    return within(new Promise<void>((resolve, reject) => {
      socket.write(frame(HEADERS, 0x05, id, block), (error) => error ? reject(error) : resolve());
    }), `write HEADERS for stream ${id}`);
  }

  async function pingBarrier() {
    const token = Buffer.from('admitted');
    socket.write(frame(PING, 0, 0, token));
    await until((item) => item.type === PING && item.flags === 1 && item.body.equals(token),
      'PING acknowledgement after raced HEADERS');
  }

  return { closed, frames, until, work, pingBarrier };
}
