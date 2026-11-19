export const MAX_EVENTS = 16;
export const MAX_BODY_BYTES = 8192;

export type EventPayload = {id: string; text: string};
export type ReplayEvent = EventPayload & {sequence: number};
export type Replay = {events: ReplayEvent[]; lastEventId: number};

export function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function isEventPayload(value: unknown): value is EventPayload {
  return exactKeys(value, ['id', 'text'])
    && typeof value.id === 'string' && /^[a-z0-9]{1,16}$/.test(value.id)
    && typeof value.text === 'string' && /^[A-Za-z ]{1,32}$/.test(value.text);
}

export function parseCursor(value: string): number | undefined {
  if (!/^(?:0|[1-9][0-9]?)$/.test(value)) return undefined;
  const cursor = Number(value);
  return cursor <= MAX_EVENTS ? cursor : undefined;
}

export function replayCursor(target: string): number | undefined {
  const prefix = '/replay?after=';
  return target.startsWith(prefix) ? parseCursor(target.slice(prefix.length)) : undefined;
}

export function feedOrigin(raw: string | undefined): string {
  const invalid = 'FEED_ORIGIN must be an HTTP origin on 127.0.0.1 with a nonzero port';
  if (raw === undefined || !/^http:\/\/127\.0\.0\.1(?::[0-9]+)?\/?$/i.test(raw)) {
    throw new Error(invalid);
  }
  const url = URL.parse(raw);
  if (url === null || url.port === '0') throw new Error(invalid);
  return url.origin;
}

export function databasePath(raw: string | undefined): string {
  if (!raw || raw === ':memory:' || /^file:/i.test(raw)) {
    throw new Error('DB_PATH must name a private SQLite file');
  }
  return raw;
}
