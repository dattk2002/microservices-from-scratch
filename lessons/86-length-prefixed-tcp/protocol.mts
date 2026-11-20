export type WorkerAddress = {host: '127.0.0.1'; port: number};

export function workerAddress(origin = 'tcp://127.0.0.1:3086'): WorkerAddress {
  const match = /^tcp:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(origin);
  const port = Number(match?.[1]);
  if (match?.[0] !== origin || port > 65535) throw new Error('Invalid WORKER_ORIGIN');
  return {host: '127.0.0.1', port};
}

function exactField(value: unknown, key: string): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 1 && Object.hasOwn(value, key);
}

export function requestText(value: unknown): string {
  if (!exactField(value, 'text') || typeof value.text !== 'string'
    || value.text.length < 1 || value.text.length > 64 || /[^A-Za-z0-9 ]/.test(value.text)) {
    throw new Error('invalid text request');
  }
  return value.text;
}

export function checkEcho(value: unknown, requested: string): void {
  if (!exactField(value, 'echo') || value.echo !== requested) throw new Error('invalid echo response');
}

export function parseJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes));
}
