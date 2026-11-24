// Server-to-client h2c starts with frames. Node still validates framing and HPACK.
// Node may emit readable 'end' for RST_STREAM(NO_ERROR); keep wire EOF separately.
export class ResponseEnd {
  readonly #ended = new Map<number, boolean | 'reset'>();
  readonly #header = Buffer.alloc(9);
  #headerBytes = 0;
  #remaining = 0;
  #completedId: number | undefined;

  track(id: number) { this.#ended.set(id, false); }
  forget(id: number) { this.#ended.delete(id); }
  complete(id: number) { return this.#ended.get(id) === true; }

  observe(chunk: Buffer) {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.#headerBytes < 9) {
        const count = Math.min(9 - this.#headerBytes, chunk.length - offset);
        chunk.copy(this.#header, this.#headerBytes, offset, offset + count);
        this.#headerBytes += count;
        offset += count;
        if (this.#headerBytes < 9) return;

        this.#remaining = this.#header.readUIntBE(0, 3);
        const type = this.#header.readUInt8(3);
        const flags = this.#header.readUInt8(4);
        const id = this.#header.readUInt32BE(5) & 0x7fff_ffff;
        if (type === 3 && this.#ended.has(id)) this.#ended.set(id, 'reset');
        this.#completedId = (type === 0 || type === 1) && (flags & 1) !== 0 ? id : undefined;
      }
      const count = Math.min(this.#remaining, chunk.length - offset);
      this.#remaining -= count;
      offset += count;
      if (this.#remaining === 0) {
        if (this.#completedId !== undefined && this.#ended.has(this.#completedId)
            && this.#ended.get(this.#completedId) !== 'reset') {
          this.#ended.set(this.#completedId, true);
        }
        this.#headerBytes = 0;
      }
    }
  }
}
