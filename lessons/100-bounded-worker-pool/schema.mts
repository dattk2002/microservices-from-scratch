export type Input = {text: string; iterations: number};

export function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function parseInput(value: unknown): Input | undefined {
  if (!exact(value, ['text', 'iterations'])) return;
  const {text, iterations} = value;
  if (typeof text !== 'string' || /[\uD800-\uDFFF]/u.test(text) || text.length === 0 ||
      Buffer.byteLength(text) > 1024 || typeof iterations !== 'number' ||
      !Number.isInteger(iterations) || iterations < 1 || iterations > 200000) return;
  return {text, iterations};
}

export function isDigest(value: unknown): value is string {
  return typeof value === 'string' && value.length === 64 && /^[a-f0-9]+$/.test(value);
}
