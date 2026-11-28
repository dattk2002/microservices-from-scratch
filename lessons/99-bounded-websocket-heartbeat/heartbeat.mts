const PING_INTERVAL = 250;
const PONG_TIMEOUT = 1000;

export class Heartbeat {
  private nextPing: number;
  private pending: { token: Buffer; deadline: number } | undefined;

  private readonly now: () => number;
  private readonly token: () => Buffer;

  constructor(now: () => number, token: () => Buffer) {
    this.now = now;
    this.token = token;
    this.nextPing = now() + PING_INTERVAL;
  }

  delay(): number {
    return Math.max(0, Math.ceil((this.pending?.deadline ?? this.nextPing) - this.now()));
  }

  expired(): boolean {
    return this.pending !== undefined && this.now() >= this.pending.deadline;
  }

  tick(): Buffer | 'expired' | undefined {
    if (this.pending) return this.expired() ? 'expired' : undefined;
    const now = this.now();
    if (now < this.nextPing) return;
    const token = this.token();
    this.pending = { token, deadline: now + PONG_TIMEOUT };
    this.nextPing = now + PING_INTERVAL;
    return token;
  }

  pong(payload: Buffer): boolean {
    if (!this.pending?.token.equals(payload) || this.expired()) return false;
    this.pending = undefined;
    return true;
  }
}
