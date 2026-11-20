// Server-to-client h2c starts with frames (there is no client connection preface
// on this side). Node still decodes and validates every frame and header block.
export class FastEnd {
  #streamId: number | undefined;
  readonly #header = Buffer.alloc(9);
  #headerBytes = 0;
  #remaining = 0;
  #finishesFast = false;
  ended = false;

  track(streamId: number) {
    this.#streamId = streamId;
  }

  observe(chunk: Buffer) {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.#headerBytes < 9) {
        const count = Math.min(9 - this.#headerBytes, chunk.length - offset);
        chunk.copy(this.#header, this.#headerBytes, offset, offset + count);
        offset += count;
        this.#headerBytes += count;
        if (this.#headerBytes < 9) return;

        this.#remaining = this.#header.readUIntBE(0, 3);
        const type = this.#header.readUInt8(3);
        const flags = this.#header.readUInt8(4);
        const id = this.#header.readUInt32BE(5) & 0x7fff_ffff;
        if (id === this.#streamId && type === 3) {
          // A RST_STREAM (including NO_ERROR) cannot serve as a clean EOF.
          this.#streamId = undefined;
          this.ended = false;
        }
        this.#finishesFast = id === this.#streamId && (type === 0 || type === 1) && (flags & 1) !== 0;
      }
      const count = Math.min(this.#remaining, chunk.length - offset);
      this.#remaining -= count;
      offset += count;
      if (this.#remaining === 0) {
        if (this.#finishesFast) this.ended = true;
        this.#headerBytes = 0;
      }
    }
  }
}
