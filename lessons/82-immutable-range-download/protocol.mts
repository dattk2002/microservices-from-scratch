import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { HttpError, json } from '../../lib/http.mts';

export const MAX_OBJECT_BYTES = 128;
const DECIMAL = '0|[1-9][0-9]*';
const RANGE = new RegExp(`^bytes=(${DECIMAL})-(${DECIMAL})?$`);
const STRONG_TAG = /^"[0-9a-f]{64}"$/;

export type ResumeRequest = {id: string; prefix: string; etag: string | null};

export function fail(status: number, code: string): never {
  throw new HttpError(status, code, code);
}

export function errorBody(code: string) {
  return {error: {code, message: code}};
}

export function replyError(res: ServerResponse, error: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.setHeader('connection', 'close');
  if (error instanceof HttpError) json(res, error.status, errorBody(error.code));
  else json(res, 500, errorBody('internal_error'));
}

function exactFields(value: unknown, ...keys: string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^o[0-7]$/.test(value);
}

export function isPrintable(value: unknown, min: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= MAX_OBJECT_BYTES
    && !/[^ -~]/.test(value);
}

export function isStrongTag(value: unknown): value is string {
  return typeof value === 'string' && STRONG_TAG.test(value);
}

export function strongTag(bytes: Uint8Array): string {
  return `"${createHash('sha256').update(bytes).digest('hex')}"`;
}

export function validPutBody(value: unknown): value is {text: string} {
  return exactFields(value, 'text') && isPrintable(value.text, 1);
}

export function validResumeBody(value: unknown): value is ResumeRequest {
  return exactFields(value, 'id', 'prefix', 'etag') && isObjectId(value.id)
    && isPrintable(value.prefix, 0) && (isStrongTag(value.etag) || (value.etag === null && value.prefix === ''));
}

export function validErrorBody(value: unknown, code: string): boolean {
  return exactFields(value, 'error') && exactFields(value.error, 'code', 'message')
    && value.error.code === code && value.error.message === code;
}

type RangeSelection = {kind: 'full'} | {kind: 'partial'; start: number; end: number} | {kind: 'unsatisfiable'};

export function selectRange(
  range: string | undefined, ifRange: string | undefined, etag: string, size: number,
): RangeSelection {
  if (range === undefined) return {kind: 'full'};
  const match = RANGE.exec(range);
  if (!match) fail(400, 'invalid_range');
  if (ifRange !== undefined) {
    const tag = ifRange.startsWith('W/') ? ifRange.slice(2) : ifRange;
    if (!STRONG_TAG.test(tag)) fail(400, 'invalid_if_range');
    if (ifRange !== etag) return {kind: 'full'};
  }

  // For this bounded object any too-large start is unsatisfiable and any too-large
  // end is clamped. Even a decimal overflowing Number to Infinity has that meaning.
  const start = Number(match[1]);
  const end = match[2] === undefined ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (start >= size || end < start) return {kind: 'unsatisfiable'};
  return {kind: 'partial', start, end};
}
