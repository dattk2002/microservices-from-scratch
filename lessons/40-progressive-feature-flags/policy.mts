import { createHash } from 'node:crypto';
import { HttpError } from '../../lib/http.mts';
export type Config = {version: number; enabled: boolean; rollout: number; salt: string};
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'invalid_input', 'JSON object required');
  return value as Record<string, unknown>;
}
export function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error('integer out of range');
  return value;
}
export function parseConfig(value: unknown): Config {
  const c = record(value);
  if (Object.keys(c).sort().join(',') !== 'enabled,rollout,salt,version' || typeof c.enabled !== 'boolean' || typeof c.salt !== 'string' || c.salt.length < 1 || c.salt.length > 64) throw new Error('invalid config');
  return {version: integer(c.version, 0, Number.MAX_SAFE_INTEGER), enabled: c.enabled, rollout: integer(c.rollout, 0, 10000), salt: c.salt};
}
export function bucket(salt: string, subject: string): number {
  return createHash('sha256').update(salt).update('\0').update(subject).digest().readUInt32BE(0) % 10000;
}
export class Snapshot {
  #config: Config | undefined;
  #success = 0;
  readonly ttl: number;
  readonly clock: () => number;
  constructor(ttl: number, clock: () => number) { this.ttl = ttl; this.clock = clock; }
  accept(value: unknown): Config {
    const next = parseConfig(value), previous = this.#config;
    if (previous && (next.version < previous.version || (next.version === previous.version && JSON.stringify(next) !== JSON.stringify(previous)))) throw new Error('version conflict');
    this.#config = next; this.#success = this.clock(); return {...next};
  }
  choose(subject: string) {
    const c = this.#config;
    const reason = !c ? 'cold' : this.clock() - this.#success >= this.ttl ? 'expired' : !c.enabled ? 'disabled' : 'configured';
    return {variant: reason === 'configured' && c && bucket(c.salt, subject) < c.rollout ? 'canary' : 'stable', reason, version: c?.version ?? null};
  }
}
