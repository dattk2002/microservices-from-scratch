import { HttpError } from '../../lib/http.mts';

export type Json = null | boolean | number | string | Json[] | JsonObject;
type JsonObject = { [key: string]: Json };

export const MAX_BYTES = 8192;
const MAX_DEPTH = 8;
const MAX_NODES = 128;

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonObject(value: Json | undefined): value is JsonObject {
  return isObject(value);
}

function tooLarge(): never {
  throw new HttpError(413, 'body_too_large', 'body_too_large');
}

export function validateJson(value: unknown): asserts value is Json {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let nodes = 1;
  function add(child: unknown, depth: number): void {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) tooLarge();
    pending.push({ value: child, depth });
  }

  for (let next = pending.pop(); next; next = pending.pop()) {
    const { value: current, depth } = next;
    if (current === null || typeof current === 'string' || typeof current === 'boolean') continue;
    if (typeof current === 'number' && Number.isFinite(current)) continue;
    if (Array.isArray(current)) {
      const items: readonly unknown[] = current;
      for (let i = 0; i < items.length; i++) {
        if (!Object.prototype.propertyIsEnumerable.call(items, i)) invalidValue();
        add(items[i], depth + 1);
      }
    } else if (isObject(current)) {
      for (const key in current) {
        if (Object.hasOwn(current, key)) add(current[key], depth + 1);
      }
    } else {
      invalidValue();
    }
  }
}

function invalidValue(): never {
  throw new HttpError(400, 'invalid_body', 'invalid_body');
}

function copy(value: Json): Json {
  if (Array.isArray(value)) {
    const result: Json[] = [];
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (item === undefined) invalidValue();
      result.push(copy(item));
    }
    return result;
  }
  if (!isJsonObject(value)) return value;
  const result: JsonObject = { __proto__: null };
  for (const [key, member] of Object.entries(value)) result[key] = copy(member);
  return result;
}

function merge(target: Json | undefined, patch: Json): Json {
  if (!isJsonObject(patch)) return copy(patch);
  const result: JsonObject = { __proto__: null };
  const base = isJsonObject(target) ? target : undefined;
  if (base) {
    for (const [key, member] of Object.entries(base)) {
      if (!Object.prototype.propertyIsEnumerable.call(patch, key)) result[key] = copy(member);
      else {
        const update = patch[key];
        if (update !== null && update !== undefined) result[key] = merge(member, update);
      }
    }
  }
  for (const [key, update] of Object.entries(patch)) {
    if (update !== null && (!base || !Object.prototype.propertyIsEnumerable.call(base, key))) {
      result[key] = merge(undefined, update);
    }
  }
  return result;
}

export function mergePatch(target: Json, patch: Json): Json {
  validateJson(target);
  validateJson(patch);
  const result = merge(target, patch);
  validateJson(result);
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) tooLarge();
  return result;
}

// Called on bounded JSON. Object order is irrelevant, while array order matters.
export function jsonEqual(left: Json, right: Json): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) {
      const member = left[i];
      const other = right[i];
      if (member === undefined || other === undefined || !jsonEqual(member, other)) return false;
    }
    return true;
  }
  if (!isJsonObject(left) || !isJsonObject(right)) return false;
  const entries = Object.entries(left);
  return entries.length === Object.keys(right).length && entries.every(([key, member]) => {
    const other = Object.prototype.propertyIsEnumerable.call(right, key) ? right[key] : undefined;
    return other !== undefined && jsonEqual(member, other);
  });
}
