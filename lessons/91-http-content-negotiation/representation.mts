import { chooseVariant, isAcceptable } from './accept.mts';
import type { Range, Variant } from './accept.mts';
import { framing, MAX_BODY, oneField } from './fields.mts';

export const greeting = { greeting: 'xin-chao' };
export const plainGreeting = 'xin-chao\n';

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const contentType = /^(application\/json|text\/plain)[ \t]*;[ \t]*charset=(?:utf-8|"utf-8")$/i;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEnvelope(text: string, expectedMembers: number): unknown {
  const value: unknown = JSON.parse(text);
  // This protocol has fixed object shapes. Count every JSON member token, including
  // ones JSON.parse would replace; string-value tokens are consumed as a whole.
  const members = [...text.matchAll(/"(?:[^"\\]|\\.)*"[ \t\r\n]*:|"(?:[^"\\]|\\.)*"/g)]
    .filter(([token]) => token.endsWith(':'));
  if (members.length !== expectedMembers) throw new Error('Unexpected JSON member count');
  return value;
}

function exactError(value: unknown): boolean {
  if (!record(value) || Object.keys(value).length !== 1) return false;
  const error = value.error;
  return record(error) && Object.keys(error).length === 2 &&
    error.code === 'not_acceptable' && error.message === 'not_acceptable';
}

export function validateReply(
  status: number, fields: readonly string[], body: Buffer, ranges: readonly Range[],
): Variant | undefined {
  const { length } = framing(fields);
  const media = contentType.exec(oneField(fields, 'content-type') ?? '')?.[1]?.toLowerCase();
  const coding = oneField(fields, 'content-encoding')?.toLowerCase();
  const vary = oneField(fields, 'vary')?.toLowerCase();
  if (body.length > MAX_BODY || (length !== undefined && length !== body.length) ||
      (coding !== undefined && coding !== 'identity') || vary !== 'accept' ||
      (media !== 'application/json' && media !== 'text/plain') ||
      (status !== 200 && status !== 406)) throw new Error('Unexpected provider response');

  const text = utf8.decode(body);
  if (status === 406) {
    if (media !== 'application/json' || chooseVariant(ranges) !== undefined) throw new Error('Unexpected refusal');
    const value = parseEnvelope(text, 3);
    if (!exactError(value)) throw new Error('Invalid refusal');
    return undefined;
  }

  if (!isAcceptable(media, ranges)) throw new Error('Unacceptable provider representation');
  if (media === 'text/plain') {
    if (text !== plainGreeting) throw new Error('Invalid plain greeting');
  } else {
    const value = parseEnvelope(text, 1);
    if (!record(value) || Object.keys(value).length !== 1 || value.greeting !== greeting.greeting) {
      throw new Error('Invalid JSON greeting');
    }
  }
  return media;
}
