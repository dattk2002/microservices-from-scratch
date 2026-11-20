const HEADER_BYTES = 4;
const MAX_PAYLOAD_BYTES = 1024;

function checkLength(length: number): void {
  if (length < 1 || length > MAX_PAYLOAD_BYTES) throw new Error('invalid frame length');
}

export function encodeFrame(payload: Uint8Array): Buffer {
  checkLength(payload.length);
  const frame = Buffer.alloc(HEADER_BYTES + payload.length);
  frame.writeUInt32BE(payload.length);
  frame.set(payload, HEADER_BYTES);
  return frame;
}

export class FrameDecoder {
  readonly #header = Buffer.alloc(HEADER_BYTES);
  #payload: Buffer | undefined;
  #filled = 0;
  #ended = false;

  push(chunk: Uint8Array, frameBudget = Infinity): Buffer[] {
    if (this.#ended) throw new Error('decoder has ended');
    const frames: Buffer[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      const target = this.#payload ?? this.#header;
      const size = Math.min(chunk.length - offset, target.length - this.#filled);
      target.set(chunk.subarray(offset, offset + size), this.#filled);
      this.#filled += size;
      offset += size;
      if (this.#filled !== target.length) continue;

      this.#filled = 0;
      if (this.#payload === undefined) {
        const length = this.#header.readUInt32BE();
        try {
          checkLength(length);
          if (frames.length >= frameBudget) throw new Error('extra frame');
        } catch (error) {
          this.#ended = true;
          throw error;
        }
        this.#payload = Buffer.alloc(length);
      } else {
        frames.push(this.#payload);
        this.#payload = undefined;
      }
    }
    return frames;
  }

  finish(): void {
    if (this.#ended) throw new Error('decoder has ended');
    this.#ended = true;
    if (this.#filled !== 0 || this.#payload !== undefined) throw new Error('truncated frame');
  }
}

export class SingleFrame {
  readonly #decoder = new FrameDecoder();
  #frame: Buffer | undefined;

  push(chunk: Uint8Array): void {
    // A second header fails before the decoder allocates another payload.
    const [frame] = this.#decoder.push(chunk, this.#frame === undefined ? 1 : 0);
    this.#frame ??= frame;
  }

  finish(): Buffer {
    this.#decoder.finish();
    if (this.#frame === undefined) throw new Error('missing frame');
    return this.#frame;
  }
}
