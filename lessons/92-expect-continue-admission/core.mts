export const LIMIT = 8192;
export const BUDGET_MS = 500;
export const statuses = {
  invalid_headers: 400,
  not_found: 404,
  method_not_allowed: 405,
  body_timeout: 408,
  length_required: 411,
  body_too_large: 413,
  unsupported_media_type: 415,
  expectation_failed: 417,
  busy: 503,
} as const;

type ErrorCode = keyof typeof statuses;

export type Admission =
  | {kind: 'upload'; length: number; expect: boolean}
  | {kind: 'health'}
  | {kind: 'stats'}
  | {kind: 'error'; code: ErrorCode; allow?: string};

export function rawFields(raw: readonly string[]): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index]?.toLowerCase();
    const value = raw[index + 1];
    if (name === undefined || value === undefined) continue;
    const existing = fields.get(name);
    if (existing) existing.push(value);
    else fields.set(name, [value]);
  }
  return fields;
}

export function admit(method: string | undefined, path: string | undefined, raw: string[]): Admission {
  const fields = rawFields(raw);
  if ((fields.get('host')?.length ?? 0) > 1) return {kind: 'error', code: 'invalid_headers'};
  const [route] = path?.split('?', 1) ?? [];
  if (route !== '/upload' && route !== '/health' && route !== '/stats') {
    return {kind: 'error', code: 'not_found'};
  }
  const allow = route === '/upload' ? 'POST' : 'GET';
  if (method !== allow) return {kind: 'error', code: 'method_not_allowed', allow};
  if (path !== route) return {kind: 'error', code: 'invalid_headers'};

  const relevant = ['host', 'connection', 'content-type', 'content-length', 'content-encoding',
    'transfer-encoding', 'expect', 'trailer', 'upgrade'];
  if (relevant.some(name => (fields.get(name)?.length ?? 0) > 1)
    || ['content-encoding', 'transfer-encoding', 'trailer', 'upgrade'].some(name => fields.has(name))) {
    return {kind: 'error', code: 'invalid_headers'};
  }
  const expectation = fields.get('expect')?.[0];
  if (expectation !== undefined && (route !== '/upload' || expectation.toLowerCase() !== '100-continue')) {
    return {kind: 'error', code: 'expectation_failed'};
  }
  const length = fields.get('content-length')?.[0];
  if (route !== '/upload') {
    if (length !== undefined && length !== '0') return {kind: 'error', code: 'invalid_headers'};
    return route === '/health' ? {kind: 'health'} : {kind: 'stats'};
  }
  if (fields.get('content-type')?.[0]?.toLowerCase() !== 'application/octet-stream') {
    return {kind: 'error', code: 'unsupported_media_type'};
  }
  if (length === undefined) return {kind: 'error', code: 'length_required'};
  if (!/^[1-9][0-9]*$/.test(length)) return {kind: 'error', code: 'invalid_headers'};
  if (Number(length) > LIMIT) return {kind: 'error', code: 'body_too_large'};
  return {kind: 'upload', length: Number(length), expect: expectation !== undefined};
}

export function createSlot() {
  let active = false;
  let accepted = 0;
  let completed = 0;
  let bytes = 0;
  return {
    stats: () => ({accepted, completed, bytes, active: Number(active)}),
    reserve() {
      if (active) return undefined;
      active = true;
      accepted = Math.min(Number.MAX_SAFE_INTEGER, accepted + 1);
      let released = false;
      let finished = false;
      return {
        consume(size: number) {
          if (!released && !finished) bytes = Math.min(Number.MAX_SAFE_INTEGER, bytes + size);
        },
        complete() {
          if (released || finished) return;
          finished = true;
          completed = Math.min(Number.MAX_SAFE_INTEGER, completed + 1);
        },
        release() {
          if (released) return;
          released = true;
          active = false;
        },
      };
    },
  };
}

export function createUploadState() {
  let sent = false;
  let final = false;
  return {
    information(status: number) {
      if (final || sent || status !== 100) return false;
      sent = true;
      return true;
    },
    sent: () => sent,
    final: () => { final = true; },
  };
}

export type Result =
  | {ok: true; bytes: number; sha256: string}
  | {ok: false; status: number; error: {code: ErrorCode; message: ErrorCode}};

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateResult(status: number, body: unknown, length: number, digest: string, sent: boolean): Result | undefined {
  if (!record(body)) return;
  if (status === 201) {
    if (sent && Object.keys(body).length === 2 && body.bytes === length
      && typeof body.sha256 === 'string' && /^[a-f0-9]{64}$/.test(body.sha256) && body.sha256 === digest) {
      return {ok: true, bytes: length, sha256: body.sha256};
    }
    return;
  }

  const envelope = body.error;
  if (Object.keys(body).length !== 1 || !record(envelope) || Object.keys(envelope).length !== 2) return;
  for (const code in statuses) {
    if (isErrorCode(code) && statuses[code] === status && envelope.code === code && envelope.message === code) {
      return {ok: false, status, error: {code, message: code}};
    }
  }
}

function isErrorCode(value: string): value is ErrorCode {
  return Object.hasOwn(statuses, value);
}
