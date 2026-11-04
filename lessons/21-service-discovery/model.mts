import { randomUUID } from 'node:crypto';
import { HttpError } from '../../lib/http.mts';
export type Member = { id: string; url: string; owner: string; expires: number };
export function invalid(): never { throw new HttpError(400, 'invalid_registration', 'Invalid registration'); }
export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(value)) return invalid();
  return value;
}
export function localUrl(value: unknown): string {
  if (typeof value !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(value)) return invalid();
  if (Number(value.slice(value.lastIndexOf(':') + 1)) > 65535) return invalid();
  return value;
}
export function leaseValue(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 5000) return invalid();
  return value;
}
export class Registry {
  readonly now: () => number;
  readonly capacity: number;
  private members = new Map<string, Member>();
  constructor(now: () => number, capacity = 16) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 256) invalid();
    this.now = now; this.capacity = capacity;
  }
  list(): Member[] {
    const now = this.now();
    for (const [id, member] of this.members) if (member.expires <= now) this.members.delete(id);
    return [...this.members.values()].sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(m => ({...m}));
  }
  register(id: string, url: string, lease: number): Member {
    identifier(id); localUrl(url); leaseValue(lease); this.list();
    if (this.members.has(id)) throw new HttpError(409, 'owned', 'ID already leased');
    if (this.members.size >= this.capacity) throw new HttpError(503, 'capacity', 'Registry full');
    const member = { id, url, owner: randomUUID(), expires: this.now() + lease };
    this.members.set(id, member); return {...member};
  }
  private owned(id: string, owner: string): Member {
    identifier(id); this.list();
    const member = this.members.get(id);
    if (!member || member.owner !== owner) throw new HttpError(409, 'ownership', 'Lease expired or different owner');
    return member;
  }
  renew(id: string, owner: string, lease: number): void {
    leaseValue(lease); this.owned(id, owner).expires = this.now() + lease;
  }
  remove(id: string, owner: string): void { this.owned(id, owner); this.members.delete(id); }
}
export class RoundRobin {
  private last = '';
  next(members: Member[]): Member | undefined {
    const sorted = [...members].sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const chosen = sorted.find(m => m.id > this.last) ?? sorted[0];
    if (chosen) this.last = chosen.id;
    return chosen;
  }
}
