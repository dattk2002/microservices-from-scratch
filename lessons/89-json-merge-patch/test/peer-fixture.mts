import type { ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { json, serve } from '../../../lib/http.mts';
import { runningDirectly } from '../http.mts';
import { filler } from './wire.mts';

const profile = '{"name":"Peer","tags":["test"]}';
const errorBody = (code: string) => JSON.stringify({ error: { code, message: code } });
const semantic = new Map<string, [number, string]>([
  ['412', [412, 'precondition_failed']], ['422', [422, 'invalid_document']],
  ['409', [409, 'revision_exhausted']], ['413', [413, 'body_too_large']],
]);
type FixtureReply = { status?: number; media?: string; tag?: string | null; body?: string | Buffer; late?: string[] };

const replies = new Map<string, FixtureReply>([
  ['wrong-message', { status: 422, body: '{"error":{"code":"invalid_document","message":"other"}}' }],
  ['array-error', { status: 413, body: '[{"error":{"code":"body_too_large","message":"body_too_large"}}]' }],
  ['null-error', { status: 412, body: 'null' }],
  ['extra-error', { status: 409, body: '{"error":{"code":"revision_exhausted","message":"revision_exhausted","extra":true}}' }],
  ['weak-tag', { tag: 'W/"v2"' }],
  ['missing-tag', { tag: null }],
  ['duplicate-tag', { late: [...filler(), 'etag', '"v2"'] }],
  ['duplicate-media', { late: [...filler(), 'content-type', 'application/json'] }],
  ['duplicate-coding', { late: ['content-encoding', 'identity', ...filler(), 'content-encoding', 'identity'] }],
  ['bad-profile', { body: '{"name":"Peer","tags":[],"extra":0}' }],
  ['array-profile', { body: '[{"name":"Peer","tags":[]}]' }],
  ['bad-media', { media: 'application/json; charset=utf-8; charset=utf-8' }],
  ['bad-coding', { late: ['content-encoding', 'gzip'] }],
  ['invalid-json', { body: '{"name":' }],
  ['invalid-utf8', { body: Buffer.concat([Buffer.from('{"name":"'), Buffer.from([0xff]), Buffer.from('","tags":[]}')]) }],
  ['non-finite', { body: '{"name":"Peer","tags":[],"note":1e1000}' }],
  ['overwritten-number-profile', { body: '{"name":1e1000,"name":"Peer","tags":["test"]}' }],
  ['overwritten-number-error', {
    status: 422, body: '{"error":{"code":1e1000,"code":"invalid_document","message":"invalid_document"}}',
  }],
]);

function reply(res: ServerResponse, options: FixtureReply = {}): void {
  const { status = 200, media = 'application/json; charset="UTF-8"', tag = '"v2"', body = profile, late = [] } = options;
  const headers = ['content-type', media];
  if (tag !== null && status === 200) headers.push('etag', tag);
  headers.push(...late, 'content-length', String(Buffer.byteLength(body)));
  res.writeHead(status, headers).end(body);
}

async function main(): Promise<void> {
  let mode = 'ok';
  let hits = 0;
  let modeStartedAt = 0;
  let cancelled = 0;
  let last: unknown = null;
  const held = new Set<ServerResponse>();

  await serve('peer-fixture', 0, async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/mode') {
      const requested = url.searchParams.get('name');
      if (!requested) { json(res, 400, { error: 'missing mode' }); return; }
      mode = requested;
      modeStartedAt = hits;
      json(res, 200, { mode });
      return;
    }
    if (url.pathname === '/stats') { json(res, 200, { hits, held: held.size, cancelled, last }); return; }
    if (url.pathname === '/release' || url.pathname === '/release-all') {
      for (const waiting of held) {
        held.delete(waiting);
        reply(waiting);
        if (url.pathname === '/release') break;
      }
      json(res, 200, { held: held.size });
      return;
    }
    if (url.pathname !== '/profile') { json(res, 404, { error: 'unknown fixture route' }); return; }

    hits++;
    const kind = mode;
    const first = hits === modeStartedAt + 1;
    const abort = new AbortController();
    res.once('close', () => {
      held.delete(res);
      if (!res.writableFinished) {
        cancelled++;
        abort.abort();
      }
    });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      if (!Buffer.isBuffer(chunk)) throw new Error('Expected byte chunk');
      size += chunk.length;
      if (size > 8192) throw new Error('Fixture request too large');
      chunks.push(chunk);
    }
    last = {
      method: req.method, media: req.headers['content-type'], tag: req.headers['if-match'],
      encoding: req.headers['accept-encoding'], body: Buffer.concat(chunks).toString('utf8'),
    };

    if (kind === 'hold') { held.add(res); return; }
    if (kind === '421' && first) { reply(res, { status: 421, body: errorBody('misdirected') }); return; }
    if (kind === 'redirect') {
      const destination = process.env.REDIRECT_TO;
      if (!destination) throw new Error('REDIRECT_TO required');
      reply(res, { status: 307, late: ['location', destination + '/profile', 'etag', '"v2"'] });
      return;
    }
    if (kind === 'missing-eof' || kind === 'split-deadline') {
      if (kind === 'split-deadline') await delay(300, undefined, { signal: abort.signal });
      res.writeHead(200, { 'content-type': 'application/json', etag: '"v2"' });
      res.write(profile);
      if (kind === 'split-deadline') {
        await delay(300, undefined, { signal: abort.signal });
        res.end();
      }
      return;
    }
    if (kind === 'truncated') {
      res.writeHead(200, { 'content-type': 'application/json', etag: '"v2"', 'content-length': '90' }).end(profile);
      return;
    }
    if (kind === 'too-large' || kind === 'max-bytes') {
      const bytes = profile.padEnd(kind === 'too-large' ? 8193 : 8192);
      res.writeHead(200, { 'content-type': 'application/json', etag: '"v2"' });
      res.write(bytes.slice(0, 4000));
      res.end(bytes.slice(4000));
      return;
    }
    const error = semantic.get(kind.replace(/^wrong-/, ''));
    if (error) {
      const [status, code] = error;
      reply(res, { status, body: errorBody(kind.startsWith('wrong-') ? 'internal_error' : code) });
      return;
    }
    reply(res, replies.get(kind));
  });
}

if (runningDirectly(import.meta.url)) await main();
