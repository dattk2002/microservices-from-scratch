import {createHash} from 'node:crypto';
import {request} from 'node:http';
import {performance} from 'node:perf_hooks';
import {BUDGET_MS, createUploadState, LIMIT, rawFields, validateResult} from './core.mts';
import type {Result} from './core.mts';

type LocalCode = 'invalid_origin' | 'invalid_payload' | 'timeout' | 'transport_failure' | 'upstream_failure';
type LocalFailure = {ok: false; local: LocalCode};
export type UploadResult = Result | LocalFailure;

function responseLength(raw: string[]): number | undefined {
  const fields = rawFields(raw);
  const relevant = ['content-type', 'content-length', 'transfer-encoding', 'content-encoding',
    'connection', 'location', 'trailer', 'upgrade', 'allow'];
  if (relevant.some(name => (fields.get(name)?.length ?? 0) > 1)
    || ['content-encoding', 'trailer', 'upgrade'].some(name => fields.has(name))) {
    throw new Error('Ambiguous response headers');
  }

  const contentType = fields.get('content-type')?.[0] ?? '';
  // The accepted JSON representation is UTF-8, with an optional UTF-8 charset parameter.
  if (!/^application\/json(?:[ \t]*;[ \t]*charset=(?:utf-8|"utf-8"))?$/i.test(contentType)) {
    throw new Error('Unexpected media type');
  }

  const transfer = fields.get('transfer-encoding')?.[0];
  const length = fields.get('content-length')?.[0];
  if (transfer !== undefined && (transfer.toLowerCase() !== 'chunked' || length !== undefined)) {
    throw new Error('Unexpected framing');
  }
  if (length === undefined) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > LIMIT) throw new Error('Unexpected length');
  return Number(length);
}

export async function upload(origin: string, payload: string = 'hello'): Promise<UploadResult> {
  const match = /^http:\/\/127\.0\.0\.1(?::([0-9]{1,5}))?\/?$/.exec(origin);
  const port = match?.[1] === undefined ? 80 : Number(match[1]);
  if (!match || match[0] !== origin || port < 1 || port > 65535) return {ok: false, local: 'invalid_origin'};

  const length = Buffer.byteLength(payload);
  if (length < 1 || length > LIMIT) return {ok: false, local: 'invalid_payload'};
  const body = Buffer.from(payload);
  const digest = createHash('sha256').update(body).digest('hex');
  const state = createUploadState();
  const deadline = performance.now() + BUDGET_MS;

  return new Promise<UploadResult>(resolve => {
    let done = false;
    const call = request({
      hostname: '127.0.0.1', port, path: '/upload', method: 'POST',
      agent: false, maxHeaderSize: LIMIT,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': length,
        'expect': '100-continue',
        'connection': 'close',
      },
    });
    call.maxHeadersCount = 0;
    const timer = setTimeout(() => fail('timeout'), BUDGET_MS);

    function finish(result: UploadResult) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      call.destroy();
      resolve(result);
    }
    function fail(code: LocalCode) {
      finish({ok: false, local: performance.now() >= deadline ? 'timeout' : code});
    }

    call.on('error', error => fail(
      'code' in error && typeof error.code === 'string' && error.code.startsWith('HPE_')
        ? 'upstream_failure' : 'transport_failure',
    ));
    call.once('close', () => fail('transport_failure'));
    call.once('upgrade', (_response, socket) => {
      socket.destroy();
      fail('upstream_failure');
    });
    // Node also emits 'continue'; use only 'information' so one frame cannot send twice.
    call.on('information', info => {
      if (done) return;
      if (performance.now() >= deadline) return fail('timeout');
      if (info.rawHeaders.length !== 0 || !state.information(info.statusCode)) return fail('upstream_failure');
      call.end(body);
    });
    call.once('response', response => {
      response.on('error', () => fail('transport_failure'));
      response.once('aborted', () => fail('transport_failure'));
      if (done || performance.now() >= deadline) {
        return fail('timeout');
      }

      state.final();
      const status = response.statusCode ?? 0;
      let declared: number | undefined;
      try {
        if (status !== 201 && ![400, 404, 405, 408, 411, 413, 415, 417, 503].includes(status)) {
          throw new Error('Unexpected status');
        }
        declared = responseLength(response.rawHeaders);
      } catch {
        return fail('upstream_failure');
      }

      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        if (done) return;
        if (performance.now() >= deadline) return fail('timeout');
        bytes += chunk.length;
        if (bytes > LIMIT || (declared !== undefined && bytes > declared)) return fail('upstream_failure');
        chunks.push(chunk);
      });
      response.once('end', () => {
        if (done) return;
        if (performance.now() >= deadline) return fail('timeout');
        if (!response.complete || (declared !== undefined && bytes !== declared)
          || response.rawTrailers.length !== 0) return fail('upstream_failure');
        try {
          const json: unknown = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks, bytes)));
          const result = validateResult(status, json, length, digest, state.sent());
          if (performance.now() >= deadline) return fail('timeout');
          if (result === undefined) return fail('upstream_failure');
          finish(result);
        } catch {
          fail('upstream_failure');
        }
      });
    });

    call.flushHeaders();
  });
}

if (import.meta.main) {
  const result = await upload(process.env.RECEIVER_ORIGIN ?? 'http://127.0.0.1:3000', process.env.PAYLOAD);
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}
