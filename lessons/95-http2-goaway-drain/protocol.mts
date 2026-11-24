export const LIMIT = 8192;
const MAX_FIELDS = 64;
export const JSON_TYPE = 'application/json; charset=utf-8';
export const WORK_PREFIX = '{"result":';
export const WORK_SUFFIX = '"done"}';
export const WORK_BODY = WORK_PREFIX + WORK_SUFFIX;
export const WORK_RESULT = { result: 'done' };

export function errorBody(code: string) {
  return { error: { code, message: code } };
}

export class Fault extends Error {
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
  }

  readonly status: number;
}

export function fieldsOf(raw: readonly string[]): Map<string, string> {
  const fields = new Map<string, string>();
  const unique = new Set([
    ':status', ':method', ':path', ':authority', ':scheme', 'host',
    'content-length', 'transfer-encoding', 'content-type', 'content-encoding',
    'expect', 'te', 'trailer',
  ]);
  let bytes = 0;
  if (raw.length > MAX_FIELDS * 2 || raw.length % 2 !== 0) throw new Fault(400, 'invalid_headers');
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i]?.toLowerCase();
    const value = raw[i + 1];
    if (!name || value === undefined) throw new Fault(400, 'invalid_headers');
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    if (bytes > LIMIT || (fields.has(name) && unique.has(name))) throw new Fault(400, 'invalid_headers');
    fields.set(name, value);
  }
  return fields;
}

export function bodyless(fields: Map<string, string>) {
  const length = fields.get('content-length');
  if ((length !== undefined && !/^0+$/.test(length))
      || ['transfer-encoding', 'content-encoding', 'te', 'trailer', 'expect'].some((name) => fields.has(name))) {
    throw new Fault(400, 'invalid_body');
  }
}

export function route(path: string, method: string, health: boolean): '/work' | '/health' {
  if (path.includes('?')) throw new Fault(400, 'invalid_query');
  if (path !== '/work' && !(health && path === '/health')) throw new Fault(404, 'not_found');
  if (method !== 'GET') throw new Fault(405, 'method_not_allowed');
  return path === '/work' ? '/work' : '/health';
}

export function validWorkBody(bytes: Buffer): boolean {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      && Object.keys(value).length === 1 && 'result' in value && value.result === 'done';
  } catch {
    return false;
  }
}

export function responseLength(raw: readonly string[]): number | undefined {
  const fields = fieldsOf(raw);
  const contentType = fields.get('content-type') ?? '';
  // Accept the full JSON media type with at most one UTF-8 charset parameter.
  const json = /^application\/json(?:[\t ]*;[\t ]*charset=(?:utf-8|"utf-8"))?$/i;
  const encoding = fields.get('content-encoding')?.toLowerCase();
  const length = fields.get('content-length');
  if (fields.get(':status') !== '200' || !json.test(contentType)
      || (encoding !== undefined && encoding !== 'identity')
      || fields.has('transfer-encoding') || fields.has('trailer')
      || (length !== undefined && (!/^\d+$/.test(length) || Number(length) > LIMIT))) {
    throw new Fault(502, 'upstream_failure');
  }
  return length === undefined ? undefined : Number(length);
}
