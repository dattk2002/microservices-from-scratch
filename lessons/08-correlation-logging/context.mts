import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export const context = new AsyncLocalStorage<Readonly<{ id: string }>>();
export function correlationId(value: string | string[] | undefined): string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : randomUUID();
}
export function logLine(
  service: 'gateway' | 'catalog',
  event: 'request_started' | 'request_finished' | 'upstream_finished',
  status?: number,
): string {
  const current = context.getStore();
  if (!current) throw new Error('Missing request context');
  return JSON.stringify({
    timestamp: new Date().toISOString(), level: status !== undefined && status >= 500 ? 'error' : 'info',
    service, event, correlationId: current.id, ...(status === undefined ? {} : { status }),
  });
}
