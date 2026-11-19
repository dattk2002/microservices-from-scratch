import { isEventPayload, MAX_BODY_BYTES, parseCursor } from './contracts.mts';
import type { Replay, ReplayEvent } from './contracts.mts';

export function encodeEvents(events: readonly ReplayEvent[]): string {
  return events.map(({sequence, id, text}) =>
    `id: ${sequence}\nevent: item\ndata: ${JSON.stringify({id, text})}\n\n`).join('');
}

export class ReplayParser {
  readonly #after: number;
  readonly #decoder = new TextDecoder('utf-8', {fatal: true});
  readonly #events: ReplayEvent[] = [];
  readonly #seen = new Set<string>();
  #bytes = 0;
  #line = '';
  #skipLF = false;
  #lastId = '';
  #eventType = '';
  #data: string[] = [];

  constructor(after: number) {
    this.#after = after;
  }

  push(chunk: Uint8Array): void {
    this.#bytes += chunk.byteLength;
    if (this.#bytes > MAX_BODY_BYTES) throw new Error('SSE body too large');
    this.#decodeLines(this.#decoder.decode(chunk, {stream: true}));
  }

  finish(): Replay {
    this.#decodeLines(this.#decoder.decode());
    // EOF validates the decoder but never supplies the blank line needed to dispatch.
    return {events: this.#events, lastEventId: this.#events.at(-1)?.sequence ?? this.#after};
  }

  #decodeLines(text: string): void {
    for (const char of text) {
      if (this.#skipLF) {
        this.#skipLF = false;
        if (char === '\n') continue;
      }
      if (char === '\r' || char === '\n') {
        this.#consumeLine(this.#line);
        this.#line = '';
        this.#skipLF = char === '\r';
      } else {
        this.#line += char;
      }
    }
  }

  #consumeLine(line: string): void {
    if (line === '') {
      if (this.#data.length !== 0) this.#dispatch();
      this.#data = [];
      this.#eventType = '';
      return;
    }

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'id':
        // Per SSE, the ID buffer persists across blocks and ignores NUL-containing values.
        if (!value.includes('\0')) this.#lastId = value;
        break;
      case 'event':
        this.#eventType = value;
        break;
      case 'data':
        this.#data.push(value);
        break;
    }
  }

  #dispatch(): void {
    const sequence = parseCursor(this.#lastId);
    if (this.#eventType !== 'item' || sequence !== this.#after + this.#events.length + 1) {
      throw new Error('Invalid SSE event');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(this.#data.join('\n'));
    } catch {
      throw new Error('Invalid SSE event');
    }
    if (!isEventPayload(payload) || this.#seen.has(payload.id)) throw new Error('Invalid SSE event');
    this.#seen.add(payload.id);
    this.#events.push({sequence, ...payload});
  }
}
