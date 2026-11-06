import type { EventEmitter } from 'node:events';
export const LINE_BYTES = 2048;
export const STREAM_BYTES = 131072;
export function encode(value: unknown): Buffer { return Buffer.from(JSON.stringify(value)+'\n'); }
export class Parser {
  private readonly line = Buffer.alloc(LINE_BYTES);
  private length = 0;
  private total = 0;
  private count = 0;
  private ended = false;
  feed(bytes: Uint8Array): void {
    this.total += bytes.length;
    if(this.total > STREAM_BYTES) throw new Error('stream byte limit');
    for(const byte of bytes) {
      if(this.ended) throw new Error('data after terminal');
      if(this.length >= LINE_BYTES) throw new Error('line byte limit');
      this.line[this.length++] = byte;
      if(byte !== 10) continue;
      const value: unknown = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(this.line.subarray(0,this.length-1)));
      this.length = 0;
      if(typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('schema');
      if(!('type' in value) || typeof value.type !== 'string') throw new Error('type');
      if(value.type === 'item') {
        if(Object.keys(value).sort().join(',') !== 'seq,text,type' || !('seq' in value) || typeof value.seq !== 'number' || value.seq !== this.count || this.count >=64 || !('text' in value) || typeof value.text !== 'string' || value.text.length>320) throw new Error('item schema/sequence');
        this.count++;
      } else if(value.type === 'end') {
        if(Object.keys(value).sort().join(',') !== 'count,type' || !('count' in value) || typeof value.count !== 'number' || value.count !== this.count) throw new Error('terminal');
        this.ended = true;
      } else throw new Error('record type');
    }
  }
  finish(): {count:number} {
    if(!this.ended || this.length) throw new Error('incomplete stream');
    return {count:this.count};
  }
}
type Writer = Pick<EventEmitter,'once'|'off'> & { destroyed:boolean; write(chunk:Uint8Array):boolean };
export async function pump(writer: Writer, source: Iterable<Uint8Array> | AsyncIterable<Uint8Array>, signal: AbortSignal, counters = { blocked:0, drains:0 }): Promise<void> {
  // Subscribe before writing: a close/error must never leave a drain waiter stranded.
  let failure: Error | undefined;
  let wake: (()=>void) | undefined;
  const fail = () => { failure = new Error('writer interrupted'); wake?.(); };
  const drained = () => { counters.drains++; wake?.(); };
  writer.once('error',fail); writer.once('close',fail);
  signal.addEventListener('abort',fail,{once:true});
  try {
    for await(const chunk of source) {
      signal.throwIfAborted();
      if(failure || writer.destroyed) throw failure ?? new Error('closed');
      let resolveDrain: ()=>void = ()=>{};
      const wait = new Promise<void>(resolve=>{resolveDrain=resolve;});
      wake = resolveDrain;
      writer.once('drain',drained);
      const accepted = writer.write(chunk);
      if(!accepted) { counters.blocked++; await wait; }
      writer.off('drain',drained); wake = undefined;
      signal.throwIfAborted(); if(failure) throw failure;
    }
  } finally {
    writer.off('drain',drained); writer.off('error',fail); writer.off('close',fail);
    signal.removeEventListener('abort',fail);
  }
}
