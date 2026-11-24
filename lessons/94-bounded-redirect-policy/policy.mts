export type Origins = Readonly<{ start: string; target: string }>;
export type Hop = { status: number; headers: string[]; body: Buffer };
export type Result = 'success' | 'upstream_failure' | 'upstream_timeout';

export const maxBytes = 8192;
export const budget = 500;
export const resource = Object.freeze({ resource: 'manual' });
const paths = new Set(['/start', '/resource', '/step/1', '/step/2', '/step/3']);
const redirects = new Set([301, 302, 303, 307, 308]);

function configuredOrigin(raw: string | undefined, name: string): string {
  if (!raw || !/^http:\/\/127\.0\.0\.1(?::[0-9]+)?\/?$/i.test(raw) || /\s/.test(raw)) {
    throw new Error(`Invalid ${name}`);
  }
  const url = URL.parse(raw);
  if (!url || url.port === '0') throw new Error(`Invalid ${name}`);
  return url.origin;
}

export function origins(start: string | undefined, target: string | undefined): Origins {
  const result = {
    start: configuredOrigin(start, 'START_ORIGIN'),
    target: configuredOrigin(target, 'TARGET_ORIGIN'),
  };
  if (result.start === result.target) throw new Error('START_ORIGIN and TARGET_ORIGIN must differ');
  return result;
}

export function targetOrigin(raw: string | undefined): string {
  return configuredOrigin(raw, 'TARGET_ORIGIN');
}

function trimOws(value: string): string {
  return value.replace(/^[\t ]+|[\t ]+$/g, '');
}

export function resolveLocation(current: string, location: string, allowed: Origins): string | undefined {
  const reference = trimOws(location);
  // Check raw syntax before WHATWG URL can discard or reinterpret characters.
  if (!reference || /[^A-Za-z0-9._~!$&'()*+,;=:@/%-]/.test(reference)
    || /%(?![0-9A-Fa-f]{2})/.test(reference)) return;
  if (/^[^/]*:/.test(reference) || reference.startsWith('//')) {
    if (!/^(?:http:)?\/\/127\.0\.0\.1(?::[0-9]+)?(?:\/|$)/i.test(reference)) return;
  }
  const url = URL.parse(reference, current);
  if (!url || (url.origin !== allowed.start && url.origin !== allowed.target)
    || !paths.has(url.pathname) || url.username || url.password || url.search || url.hash) return;
  return url.href;
}

export function fieldValues(headers: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < headers.length; index += 2) {
    const value = headers[index + 1];
    if (headers[index]?.toLowerCase() === name && value !== undefined) values.push(trimOws(value));
  }
  return values;
}

export function responseLength(headers: string[]): number | undefined {
  const lengths = fieldValues(headers, 'content-length');
  const transfers = fieldValues(headers, 'transfer-encoding');
  if (lengths.length > 1 || transfers.length > 1 || (lengths.length && transfers.length)
    || (transfers[0] !== undefined && transfers[0].toLowerCase() !== 'chunked')) {
    throw new Error('Ambiguous response framing');
  }
  const length = lengths[0];
  if (length === undefined) return undefined;
  if (!/^[0-9]+$/.test(length) || Number(length) > maxBytes) throw new Error('Invalid response length');
  return Number(length);
}

function validRepresentation(hop: Hop): boolean {
  const encodings = fieldValues(hop.headers, 'content-encoding');
  return hop.body.length <= maxBytes && encodings.length <= 1
    && (encodings[0] === undefined || encodings[0].toLowerCase() === 'identity')
    && fieldValues(hop.headers, 'content-type').length <= 1;
}

function validResource(hop: Hop): boolean {
  const [media] = fieldValues(hop.headers, 'content-type');
  if (!media || !/^application\/json(?:[ \t]*;[ \t]*charset=(?:utf-8|"utf-8"))?$/i.test(media)) return false;
  const text = new TextDecoder('utf-8', {fatal: true}).decode(hop.body);
  const value: unknown = JSON.parse(text);
  // JSON.parse validates the string tokens but collapses duplicate member names.
  const singleStringMember = /^[ \t\r\n]*\{[ \t\r\n]*"(?:[^"\\]|\\.)*"[ \t\r\n]*:[ \t\r\n]*"(?:[^"\\]|\\.)*"[ \t\r\n]*\}[ \t\r\n]*$/;
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 1 && Object.hasOwn(value, 'resource')
    && 'resource' in value && value.resource === resource.resource && singleStringMember.test(text);
}

export async function follow(
  allowed: Origins, now: () => number, call: (url: string, deadline: number) => Promise<Hop>,
): Promise<Result> {
  const deadline = now() + budget;
  const visited = new Set<string>();
  let url = allowed.start + '/start';
  try {
    for (let count = 0; count <= 3; count++) {
      if (now() >= deadline) return 'upstream_timeout';
      if (visited.has(url)) return 'upstream_failure';
      visited.add(url);

      const hop = await call(url, deadline);
      if (now() >= deadline) return 'upstream_timeout';
      if (!validRepresentation(hop)) return 'upstream_failure';
      if (hop.status === 200) {
        const valid = validResource(hop);
        if (now() >= deadline) return 'upstream_timeout';
        return valid ? 'success' : 'upstream_failure';
      }
      if (!redirects.has(hop.status) || count === 3) return 'upstream_failure';
      const locations = fieldValues(hop.headers, 'location');
      const [location] = locations;
      if (locations.length !== 1 || location === undefined) return 'upstream_failure';
      const next = resolveLocation(url, location, allowed);
      if (!next) return 'upstream_failure';
      url = next;
    }
  } catch {
    return now() >= deadline ? 'upstream_timeout' : 'upstream_failure';
  }
  return 'upstream_failure';
}
