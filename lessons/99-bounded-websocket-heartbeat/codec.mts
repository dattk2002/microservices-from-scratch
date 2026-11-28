import { randomBytes } from 'node:crypto';

export type FrameEvent =
  | { kind: 'text'; text: string }
  | { kind: 'ping' | 'pong' | 'close'; payload: Buffer }
  | { kind: 'error'; code: number };

const MESSAGE_LIMIT = 4096;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function validCloseCode(code: number): boolean {
  return (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code))
    || (code >= 3000 && code <= 4999);
}

export class Decoder {
  // Only the current frame is pending. Completed text fragments share a separate message budget.
  private readonly pending = Buffer.alloc(8192);
  private readonly message = Buffer.alloc(MESSAGE_LIMIT);
  private used = 0;
  private messageLength = 0;
  private fragmented = false;
  private stopped = false;

  private readonly masked: boolean;

  constructor(masked = true) { this.masked = masked; }

  feed(input: Buffer, emit: (event: FrameEvent) => boolean | void): void {
    let offset = 0;
    const fill = (size: number) => {
      const count = Math.min(size - this.used, input.length - offset);
      input.copy(this.pending, this.used, offset, offset + count);
      this.used += count;
      offset += count;
      return this.used === size;
    };
    const fail = (code: number) => {
      this.stopped = true;
      emit({ kind: 'error', code });
    };

    while (!this.stopped && offset < input.length) {
      if (this.used < 2 && !fill(2)) return;
      const first = this.pending.readUInt8(0);
      const second = this.pending.readUInt8(1);
      const fin = (first & 0x80) !== 0;
      const opcode = first & 15;
      const control = opcode >= 8;
      const marker = second & 127;
      if ((first & 0x70) !== 0 || ((second & 128) !== 0) !== this.masked ||
          ![0, 1, 2, 8, 9, 10].includes(opcode) ||
          (control && (!fin || marker > 125)) ||
          (!control && (opcode === 0) !== this.fragmented)) {
        return fail(1002);
      }

      const headerSize = marker < 126 ? 2 : marker === 126 ? 4 : 10;
      if (this.used < headerSize && !fill(headerSize)) return;
      const length = marker < 126 ? BigInt(marker) : marker === 126
        ? BigInt(this.pending.readUInt16BE(2))
        : this.pending.readBigUInt64BE(2);
      if ((marker === 126 && length < 126n) ||
          (marker === 127 && (length < 65536n || length >= 2n ** 63n))) {
        return fail(1002);
      }
      if (opcode === 2) return fail(1003);
      if (!control && length > BigInt(MESSAGE_LIMIT - this.messageLength)) return fail(1009);
      if (opcode === 8 && length === 1n) return fail(1002);

      const start = headerSize + (this.masked ? 4 : 0);
      const end = start + Number(length);
      if (!fill(end)) return;
      for (let i = start; this.masked && i < end; i++) {
        this.pending[i] = this.pending.readUInt8(i) ^ this.pending.readUInt8(headerSize + (i - start) % 4);
      }
      const payload = this.pending.subarray(start, end);
      this.used = 0;
      const event = this.complete(opcode, fin, payload);
      if (event && (emit(event) === false || event.kind === 'close' || event.kind === 'error')) {
        this.stopped = true;
      }
    }
  }

  private complete(opcode: number, fin: boolean, payload: Buffer): FrameEvent | undefined {
    if (opcode === 9 || opcode === 10) {
      return { kind: opcode === 9 ? 'ping' : 'pong', payload: Buffer.from(payload) };
    }
    if (opcode === 8 && payload.length >= 2 && !validCloseCode(payload.readUInt16BE(0))) {
      return { kind: 'error', code: 1002 };
    }
    try {
      if (opcode === 8) {
        utf8.decode(payload.subarray(2));
        return { kind: 'close', payload: Buffer.from(payload) };
      }
      payload.copy(this.message, this.messageLength);
      this.messageLength += payload.length;
      this.fragmented = !fin;
      if (!fin) return;
      const text = utf8.decode(this.message.subarray(0, this.messageLength));
      this.messageLength = 0;
      return { kind: 'text', text };
    } catch {
      return { kind: 'error', code: 1007 };
    }
  }
}

export function encodeFrame(opcode: number, payload: Buffer, masked = false): Buffer {
  const start = payload.length < 126 ? 2 : 4;
  const result = Buffer.alloc(start + (masked ? 4 : 0) + payload.length);
  result[0] = 128 | opcode;
  if (start === 2) result[1] = payload.length;
  else {
    result[1] = 126;
    result.writeUInt16BE(payload.length, 2);
  }
  if (masked) {
    result[1] = result.readUInt8(1) | 128;
    const key = randomBytes(4);
    key.copy(result, start);
    for (let i = 0; i < payload.length; i++) {
      result[start + 4 + i] = payload.readUInt8(i) ^ key.readUInt8(i % 4);
    }
  } else {
    payload.copy(result, start);
  }
  return result;
}
