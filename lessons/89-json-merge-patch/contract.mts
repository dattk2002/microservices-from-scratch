import { HttpError } from '../../lib/http.mts';
import { isObject, jsonEqual, mergePatch } from './merge.mts';
import type { Json } from './merge.mts';

export type Profile = { name: string; tags: string[]; note?: string };
export type Revision = { version: number; profile: Profile };
type ErrorBody = { error: { code: string; message: string } };
type ProfileReply = { status: 200; etag: string; body: Profile };
type ErrorReply = { status: number; etag?: never; body: ErrorBody };

export const MAX_VERSION = 16;
export const PATCH_MEDIA = 'application/merge-patch+json';
export const BODY_MS = 500;

export function fail(status: number, code: string): never {
  throw new HttpError(status, code, code);
}

export function errorBody(code: string): ErrorBody {
  return { error: { code, message: code } };
}

function printable(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[^\x20-\x7e]/.test(value);
}

export function isProfile(value: unknown): value is Profile {
  if (!isObject(value) || !Object.hasOwn(value, 'name') || !Object.hasOwn(value, 'tags')
    || Object.keys(value).some(key => key !== 'name' && key !== 'tags' && key !== 'note')
    || !printable(value.name, 32) || (Object.hasOwn(value, 'note') && !printable(value.note, 64))
    || !Array.isArray(value.tags) || value.tags.length > 8) return false;
  const tags: readonly unknown[] = value.tags;
  const distinct = new Set<string>();
  for (const tag of tags) {
    if (typeof tag !== 'string' || tag.length === 0 || tag.length > 16
      || /[^a-z]/.test(tag) || distinct.has(tag)) return false;
    distinct.add(tag);
  }
  return true;
}

export function patchProfile(current: Revision, expected: number, patch: Json): Revision {
  if (current.version !== expected) fail(412, 'precondition_failed');
  const profile = mergePatch(current.profile, patch);
  if (!isProfile(profile)) fail(422, 'invalid_document');
  if (jsonEqual(current.profile, profile)) return current;
  if (current.version === MAX_VERSION) fail(409, 'revision_exhausted');
  return { version: current.version + 1, profile };
}

export function etag(version: number): string {
  return `"v${version}"`;
}

export function etagVersion(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const match = /^"v(0|[1-9]|1[0-6])"$/.exec(raw);
  return match?.[0] === raw ? Number(match[1]) : undefined;
}

export function matchesMedia(raw: string | undefined, kind: 'json' | 'patch'): boolean {
  if (raw === undefined) return false;
  const match = /^[ \t]*application\/(json|merge-patch\+json)[ \t]*(?:;[ \t]*charset[ \t]*=[ \t]*(?:utf-8|"utf-8")[ \t]*)?$/i.exec(raw);
  return match?.[0] === raw && match[1]?.toLowerCase() === (kind === 'json' ? 'json' : 'merge-patch+json');
}

export function storeOrigin(raw: string): URL {
  const match = /^http:\/\/127\.0\.0\.1(?::([0-9]{1,5}))?\/?$/.exec(raw);
  if (match?.[0] !== raw || (match[1] !== undefined && (Number(match[1]) < 1 || Number(match[1]) > 65535))) {
    throw new Error('Invalid STORE_ORIGIN');
  }
  return new URL(raw);
}

const patchErrors = new Map([
  [412, 'precondition_failed'], [422, 'invalid_document'], [409, 'revision_exhausted'], [413, 'body_too_large'],
]);

export function peerReply(status: number, tag: string | undefined, body: unknown, expected?: number): ProfileReply | ErrorReply {
  if (status === 200) {
    const version = etagVersion(tag);
    if (tag === undefined || version === undefined || !isProfile(body)
      || (expected !== undefined && version !== expected && version !== expected + 1)) fail(502, 'upstream_failure');
    return { status, etag: tag, body };
  }

  const code = patchErrors.get(status);
  if (expected === undefined || code === undefined || !isObject(body)
    || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'error') || !isObject(body.error)
    || Object.keys(body.error).length !== 2 || !Object.hasOwn(body.error, 'code') || !Object.hasOwn(body.error, 'message')
    || body.error.code !== code || body.error.message !== code) fail(502, 'upstream_failure');
  return { status, body: errorBody(code) };
}
