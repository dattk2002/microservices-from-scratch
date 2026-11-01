export class Lifecycle {
  #state: 'ready' | 'draining' | 'stopped' = 'ready';
  #active = 0;
  get state() { return this.#state; }
  get active() { return this.#active; }
  get ready(): boolean { return this.#state === 'ready'; }

  admit(): (() => void) | undefined {
    if (!this.ready) return undefined;
    this.#active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active--;
    };
  }

  drain(): void {
    if (this.#state === 'ready') this.#state = 'draining';
  }

  stop(force = false): boolean {
    if (this.#state === 'ready' || (!force && this.#active !== 0)) return false;
    this.#state = 'stopped';
    return true;
  }
}
