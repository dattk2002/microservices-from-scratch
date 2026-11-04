import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { EventEmitter } from 'node:events';
export type Context = {traceId:string;spanId:string;flags:string;parentSpanId?:string};
export type Operation = 'gateway' | 'orders' | 'catalog';
export type Outcome = 'ok' | 'error' | 'cancelled';
export type SpanRecord = Context & {operation:Operation;durationMs:number;status:number;outcome:Outcome};
export const context = new AsyncLocalStorage<Context>();
export function parseParent(value: string | undefined): Context | undefined {
  if (value === undefined || !/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(value)) return;
  const traceId = value.slice(3,35), spanId = value.slice(36,52), flags = value.slice(53);
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return;
  return {traceId,spanId,flags};
}
export function childContext(value?:string, ids:(bytes:number)=>string = b => randomBytes(b).toString('hex')): Context {
  const parent = parseParent(value);
  const traceId = parent?.traceId ?? ids(16);
  const spanId = ids(8);
  if (!/^[0-9a-f]{32}$/.test(traceId) || /^0+$/.test(traceId) || !/^[0-9a-f]{16}$/.test(spanId) || /^0+$/.test(spanId) || spanId === parent?.spanId) throw new Error('Invalid generated IDs');
  return {traceId,spanId,flags:parent?.flags ?? '01', ...(parent ? {parentSpanId:parent.spanId} : {})};
}
export function encode(ctx:Context): string { return `00-${ctx.traceId}-${ctx.spanId}-${ctx.flags}`; }
export function beginSpan(operation:Operation,ctx:Context,sink:(r:SpanRecord)=>void,clock:()=>number = () => performance.now()) {
  const start = clock(); let ended = false;
  return {end(status:number,outcome:Outcome) {
    if (ended) return; ended = true;
    if (!(Number.parseInt(ctx.flags,16) & 1)) return;
    // Only fixed fields, no request metadata or error text. Duration is local and bounded.
    sink({...ctx,operation,durationMs:Math.min(86_400_000,Math.max(0,clock()-start)),status,outcome});
  }};
}
export function bindCompletion(res:EventEmitter,span:ReturnType<typeof beginSpan>,status:()=>number) {
  res.once('finish',() => span.end(status(),status() >= 400 ? 'error' : 'ok'));
  res.once('close',() => span.end(0,'cancelled'));
  res.on('error',() => span.end(0,'error'));
}
