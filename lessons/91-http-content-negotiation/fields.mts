export const MAX_HEADERS = 8192;
export const MAX_BODY = 8192;
export const DEADLINE_MS = 500;

export function fieldValues(raw: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < raw.length; index += 2) {
    const value = raw[index + 1];
    if (raw[index]?.toLowerCase() === name && value !== undefined) values.push(value);
  }
  return values;
}

export function oneField(raw: readonly string[], name: string): string | undefined {
  const values = fieldValues(raw, name);
  if (values.length > 1) throw new Error(`Duplicate ${name}`);
  return values[0];
}

export function framing(raw: readonly string[]): { length: number | undefined; chunked: boolean } {
  const length = oneField(raw, 'content-length');
  const transfer = oneField(raw, 'transfer-encoding');
  if (fieldValues(raw, 'trailer').length || (length !== undefined && transfer !== undefined) ||
      (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) ||
      (transfer !== undefined && transfer.toLowerCase() !== 'chunked')) {
    throw new Error('Unexpected framing');
  }
  return { length: length === undefined ? undefined : Number(length), chunked: transfer !== undefined };
}
