import { HttpError } from '../../lib/http.mts';
export function input(value: unknown): { id: string; refusal: boolean } {
  if (typeof value !== 'object' || value === null || !('id' in value) || typeof value.id !== 'string' ||
      !/^[a-zA-Z0-9-]{1,64}$/.test(value.id) || !('refusal' in value) || typeof value.refusal !== 'boolean') {
    throw new HttpError(400, 'invalid_input', 'Expected id (1..64 alphanumeric/hyphen) and boolean refusal');
  }
  return { id: value.id, refusal: value.refusal };
}
