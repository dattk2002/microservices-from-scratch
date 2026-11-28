import {randomUUID} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {exact, isDigest} from './schema.mts';
import type {Input} from './schema.mts';

type Failure = 'busy' | 'degraded' | 'shutting_down' | 'cancelled' | 'deadline_exceeded' | 'worker_failure';
type Result = {digest: string} | {code: Failure};
type Job = {
  id: string;
  input: Input;
  deadline: number;
  finish: (result: Result) => void;
  slot?: Slot;
};
interface WorkerPort {
  on(event: 'message', listener: (value: unknown) => void): void;
  on(event: 'error' | 'messageerror', listener: () => void): void;
  once(event: 'exit', listener: () => void): void;
  postMessage(message: unknown): void;
  terminate(): Promise<number>;
}
type Slot = {worker: WorkerPort; job?: Job; stopping: boolean; exited: Promise<void>};

function createWorker(): Worker {
  return new Worker(new URL('./worker.mts', import.meta.url), {
    workerData: 'bounded-hash-v1',
    resourceLimits: {maxOldGenerationSizeMb: 32, stackSizeMb: 2},
  });
}

export class Pool {
  private readonly slots = new Set<Slot>();
  private readonly queue: Job[] = [];
  private readonly restarts: number[] = [];
  private replacements = 0;
  private degraded = false;
  private closing = false;
  private shutdown?: Promise<void>;
  private readonly factory: () => WorkerPort;
  private readonly now: () => number;

  constructor(factory: () => WorkerPort = createWorker, now = () => performance.now()) {
    this.factory = factory;
    this.now = now;
    try {
      this.start();
      this.start();
    } catch {
      this.degrade();
      for (const slot of this.slots) this.stop(slot);
    }
  }

  stats() {
    return {
      active: [...this.slots].filter(slot => slot.job).length,
      queued: this.queue.length,
      live: this.slots.size,
      replacements: this.replacements,
    };
  }

  submit(input: Input, signal?: AbortSignal): Promise<Result> {
    if (this.closing) return Promise.resolve({code: 'shutting_down'});
    if (this.degraded) return Promise.resolve({code: 'degraded'});
    if (signal?.aborted) return Promise.resolve({code: 'cancelled'});
    this.dispatch();
    if (this.queue.length === 4) return Promise.resolve({code: 'busy'});

    return new Promise(resolve => {
      const cancel = () => this.interrupt(job, 'cancelled');
      const expire = () => {
        const remaining = job.deadline - this.now();
        if (remaining > 0) timer = setTimeout(expire, Math.ceil(remaining));
        else this.interrupt(job, 'deadline_exceeded');
      };
      const job: Job = {
        id: randomUUID(),
        input,
        deadline: this.now() + 400,
        finish: result => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', cancel);
          resolve(result);
        },
      };
      let timer = setTimeout(expire, 400);
      signal?.addEventListener('abort', cancel, {once: true});
      this.queue.push(job);
      this.dispatch();
    });
  }

  close(grace = 0): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.closing = true;
    this.rejectQueued('shutting_down');
    const slots = [...this.slots];
    for (const slot of slots) {
      if (!slot.job) this.stop(slot);
    }
    const timer = setTimeout(() => {
      for (const slot of this.slots) {
        if (slot.job) this.interrupt(slot.job, 'shutting_down');
        else this.stop(slot);
      }
    }, grace);
    this.shutdown = Promise.all(slots.map(slot => slot.exited)).then(() => {
      clearTimeout(timer);
    });
    return this.shutdown;
  }

  private start(): void {
    const worker = this.factory();
    let resolveExit = () => {};
    const exited = new Promise<void>(resolve => { resolveExit = resolve; });
    const slot: Slot = {worker, exited, stopping: false};
    this.slots.add(slot);
    worker.on('message', (value: unknown) => this.receive(slot, value));
    worker.on('messageerror', () => this.fail(slot));
    worker.on('error', () => this.fail(slot));
    worker.once('exit', () => {
      this.slots.delete(slot);
      slot.stopping = true;
      this.workerOutcome(slot, {code: 'worker_failure'});
      resolveExit();
      this.replace();
    });
  }

  private receive(slot: Slot, value: unknown): void {
    if (slot.stopping) return;
    const job = slot.job;
    if (!job || !exact(value, ['id', 'digest']) || value.id !== job.id || !isDigest(value.digest)) {
      this.fail(slot);
      return;
    }
    this.workerOutcome(slot, {digest: value.digest});
    if (this.closing) this.stop(slot);
    else this.dispatch();
  }

  private workerOutcome(slot: Slot, result: Result): void {
    if (slot.job && this.now() >= slot.job.deadline) result = {code: 'deadline_exceeded'};
    if ('code' in result) this.stop(slot);
    this.complete(slot, result);
  }

  private complete(slot: Slot, result: Result): void {
    const job = slot.job;
    if (!job) return;
    slot.job = undefined;
    job.slot = undefined;
    job.finish(result);
  }

  private stop(slot: Slot): void {
    if (slot.stopping) return;
    slot.stopping = true;
    void slot.worker.terminate().catch(() => {
      // The exit listener remains responsible for releasing the live slot.
    });
  }

  private fail(slot: Slot): void {
    this.workerOutcome(slot, {code: 'worker_failure'});
  }

  private interrupt(job: Job, code: Failure): void {
    const slot = job.slot;
    if (slot) {
      this.stop(slot);
      this.complete(slot, {code});
    } else {
      const index = this.queue.indexOf(job);
      if (index === -1) return;
      this.queue.splice(index, 1);
      job.finish({code});
    }
  }

  private replace(): void {
    if (this.closing || this.degraded) return;
    const now = this.now();
    while (this.restarts[0] !== undefined && now - this.restarts[0] >= 10000) {
      this.restarts.shift();
    }
    if (this.restarts.length === 3) {
      this.degrade();
      return;
    }
    this.restarts.push(now);
    this.replacements++;
    try {
      this.start();
    } catch {
      this.degrade();
    }
    this.dispatch();
  }

  private rejectQueued(code: Failure): void {
    for (const job of this.queue.splice(0)) {
      job.finish({code: this.now() >= job.deadline ? 'deadline_exceeded' : code});
    }
  }

  private degrade(): void {
    this.degraded = true;
    this.rejectQueued('degraded');
  }

  private dispatch(): void {
    if (this.closing || this.degraded) return;
    for (const job of [...this.queue]) {
      if (this.now() >= job.deadline) this.interrupt(job, 'deadline_exceeded');
    }
    for (const slot of this.slots) {
      if (slot.job || slot.stopping) continue;
      while (this.queue[0] && this.now() >= this.queue[0].deadline) {
        this.interrupt(this.queue[0], 'deadline_exceeded');
      }
      const job = this.queue.shift();
      if (!job) break;
      slot.job = job;
      job.slot = slot;
      try {
        slot.worker.postMessage({id: job.id, input: job.input});
      } catch {
        this.fail(slot);
      }
    }
  }
}
