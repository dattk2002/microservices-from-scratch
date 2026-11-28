export const limit = 8192;
export const deadline = 500;

export function identity(authenticated: boolean, peer: string | undefined, pin: string): string | undefined {
  return authenticated && peer === pin ? 'gateway' : undefined;
}

export function endpoint(input: string | undefined): URL {
  const match = /^https:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/?$/.exec(input ?? '');
  if (!match || match[0] !== input || Number(match[1]) > 65535) {
    throw new Error('Invalid PROVIDER_ORIGIN');
  }
  return new URL(input);
}

// Check the one-member wire grammar too, since JSON.parse collapses repeated keys.
const stringToken = String.raw`"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"`;
const space = '[ \\t\\r\\n]*';
const oneMember = new RegExp(`^${space}\\{${space}${stringToken}${space}:${space}${stringToken}${space}\\}${space}$`);

export function parseValue(body: Uint8Array): { value: 'trusted' } {
  if (body.byteLength > limit) throw new Error('Oversized value');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
  const value: unknown = JSON.parse(text);
  if (!oneMember.test(text) || typeof value !== 'object' || value === null ||
      Array.isArray(value) || Object.keys(value).length !== 1 ||
      !('value' in value) || value.value !== 'trusted') throw new Error('Invalid value');
  return { value: 'trusted' };
}

export function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value?.trim()) throw new Error(`Missing ${name}`);
  return value;
}
