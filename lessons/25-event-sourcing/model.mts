import { HttpError } from '../../lib/http.mts';
export const MAX_EVENTS = 128;
export type State = { version: number; items: Record<string, number>; checkedOut: boolean };
export type Event = { schema: 1; seq: number; type: 'created' | 'added' | 'removed' | 'checkedOut'; item?: string; quantity?: number };
export function fail(status = 422, code = 'invalid_history'): never { throw new HttpError(status, code, code); }
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_object');
  return value as Record<string, unknown>;
}
export function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(400, 'invalid_integer');
  return value;
}
export function cartId(value: string): string {
  if (!/^[a-zA-Z0-9-]{1,40}$/.test(value)) fail(400, 'invalid_cart');
  return value;
}
export function apply(state: State, value: unknown): State {
  const e = record(value);
  if (e.schema !== 1 || e.seq !== state.version + 1 || state.version >= MAX_EVENTS || state.checkedOut) fail();
  const items = { ...state.items };
  if (e.type === 'created') {
    if (state.version !== 0 || Object.keys(e).sort().join() !== 'schema,seq,type') fail();
  } else {
    if (state.version === 0) fail();
    if (e.type === 'checkedOut') {
      if (!Object.keys(items).length || Object.keys(e).sort().join() !== 'schema,seq,type') fail();
    } else if (e.type === 'added' || e.type === 'removed') {
      if (Object.keys(e).sort().join() !== 'item,quantity,schema,seq,type' || typeof e.item !== 'string' || !/^[a-z][a-z0-9-]{0,29}$/.test(e.item)) fail();
      const quantity = integer(e.quantity, 1, 99);
      const next = (Object.hasOwn(items, e.item) ? items[e.item]! : 0) + (e.type === 'added' ? quantity : -quantity);
      if (next < 0 || next > 99 || (e.type === 'removed' && !Object.hasOwn(items, e.item))) fail();
      if (next === 0) delete items[e.item]; else items[e.item] = next;
      if (Object.keys(items).length > 20) fail();
    } else fail();
  }
  return { version: state.version + 1, items, checkedOut: e.type === 'checkedOut' };
}
export function replay(events: readonly unknown[], initial: State = { version: 0, items: {}, checkedOut: false }): State {
  if (events.length > MAX_EVENTS) fail();
  return events.reduce<State>((state, event) => apply(state, event), initial);
}
export function decide(state: State, value: unknown): Event {
  const command = record(value);
  const types: Record<string, Event['type']> = { create: 'created', add: 'added', remove: 'removed', checkout: 'checkedOut' };
  if (typeof command.type !== 'string' || !Object.hasOwn(types, command.type)) fail(400, 'invalid_command');
  const type = types[command.type]!;
  const withItem = type === 'added' || type === 'removed';
  if (Object.keys(command).sort().join() !== (withItem ? 'item,quantity,type' : 'type')) fail(400, 'invalid_command');
  if (withItem && typeof command.item !== 'string') fail(400, 'invalid_item');
  const event: Event = withItem
    ? { schema: 1, seq: state.version + 1, type, item: String(command.item), quantity: integer(command.quantity, 1, 99) }
    : { schema: 1, seq: state.version + 1, type };
  apply(state, event);
  return event;
}
