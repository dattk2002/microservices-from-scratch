import { performance } from 'node:perf_hooks';
import { ProposerStore } from './store.mts';
import { exchange } from './transport.mts';
import { color, fail, ids, parseBallot, parseValue, reply, semanticError } from './protocol.mts';
import type { Chosen, Reply, Value } from './protocol.mts';
export type Exchange = (origin: string, path: '/prepare' | '/accept', body: { ballot: number; value?: Value }, signal: AbortSignal) => Promise<{ status: number; body: unknown }>;

export class Proposer {
  readonly store: ProposerStore;
  readonly send: Exchange;
  readonly now: () => number;
  private active = false;
  constructor(store: ProposerStore, send: Exchange = exchange, now: () => number = () => performance.now()) {
    this.store = store; this.send = send; this.now = now;
  }
  async propose(b: number, requested: Value): Promise<Chosen> {
    parseBallot(b); parseValue(requested);
    const old = this.store.find(b);
    if (old && old.requested !== requested) fail(409, 'ballot_conflict');
    if (this.active) fail(503, 'busy');
    if (old?.phase === 'chosen' && color(old.value)) return { ...old, value: old.value, phase: 'chosen' };
    this.active = true;
    const start = this.now(); const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    const check = () => { if (controller.signal.aborted || this.now() - start >= 500) fail(502, 'upstream_failure'); };
    try {
      let row = this.store.create(b, requested);
      const round = async (path: '/prepare' | '/accept', value?: Value): Promise<Reply[]> => {
        const votes: Reply[] = [];
        for (const id of ids) {
          check();
          try {
            const result = await this.send(this.store.targets[id], path, value === undefined ? { ballot: b } : { ballot: b, value }, controller.signal);
            check();
            if (result.status === 409 && semanticError(result.body)) continue;
            if (result.status !== 200 || !reply(result.body, id, b, path, value)) continue;
            if (result.body.ok) votes.push(result.body);
          } catch { check(); /* A failed peer never contributes a vote. */ }
        }
        return votes;
      };
      if (row.phase === 'preparing') {
        const promises = await round('/prepare');
        if (promises.length < 2) fail(502, 'upstream_failure');
        let highest = 0; let adopted = requested;
        const seen = new Map<number, Value>();
        for (const promise of promises) {
          const a = promise.accepted;
          if (!a) continue;
          if (seen.has(a.ballot) && seen.get(a.ballot) !== a.value) fail(502, 'upstream_failure');
          seen.set(a.ballot, a.value);
          if (a.ballot > highest) { highest = a.ballot; adopted = a.value; }
        }
        check(); row = this.store.adopt(b, adopted);
      }
      if (!color(row.value)) throw new Error('Missing adopted value');
      const votes = await round('/accept', row.value);
      check(); if (votes.length < 2) fail(502, 'upstream_failure');
      return this.store.choose(b);
    } finally { controller.abort(); clearTimeout(timer); this.active = false; }
  }
}
