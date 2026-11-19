export type OriginValue = { version: number; value: number };

function integerInRange(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}

export function parsePutValue(body: unknown): number {
  if (typeof body !== 'object' || body === null || Array.isArray(body) ||
      Object.keys(body).length !== 1 || !Object.hasOwn(body, 'value') ||
      !('value' in body) || !integerInRange(body.value, 100)) {
    throw new Error('Expected exactly {value} with value in 0..100');
  }
  return body.value;
}

export function parseOriginValue(body: unknown): OriginValue {
  if (typeof body !== 'object' || body === null || Array.isArray(body) ||
      Object.keys(body).length !== 2 || !Object.hasOwn(body, 'version') || !Object.hasOwn(body, 'value') ||
      !('version' in body) || !('value' in body) ||
      !integerInRange(body.version, 16) || !integerInRange(body.value, 100)) {
    throw new Error('Invalid origin snapshot');
  }
  return { version: body.version, value: body.value };
}
