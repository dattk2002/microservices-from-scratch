import {request} from 'node:http';
import {framing, problem, readJson, reply, serve} from './http.mts';
import {exact, isDigest, parseInput} from './schema.mts';
import type {Input} from './schema.mts';

type Outcome = {status: 200; digest: string} | {status: 502 | 503 | 504; code: string};

export function classify(status: number, body: unknown): Outcome | undefined {
  if (status === 200) {
    if (exact(body, ['digest']) && isDigest(body.digest)) return {status, digest: body.digest};
    return;
  }
  if (!exact(body, ['error']) || !exact(body.error, ['code', 'message'])) return;
  const {code, message} = body.error;
  if (code !== message) return;
  if (status === 504 && code === 'deadline_exceeded') return {status, code};
  if (status === 502 && code === 'worker_failure') return {status: 502, code: 'upstream_failure'};
  if (status === 503 && (code === 'busy' || code === 'degraded' || code === 'shutting_down')) {
    return {status, code};
  }
}

function computeOrigin(value: string | undefined): URL {
  if (!value || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/?$/.test(value)) {
    throw new Error('COMPUTE_ORIGIN must be http://127.0.0.1:<port>');
  }
  return new URL(value);
}

function forward(origin: URL, input: Input, caller: AbortSignal): Promise<Outcome | undefined> {
  const deadline = performance.now() + 500;
  const json = JSON.stringify(input);
  return new Promise(resolve => {
    const controller = new AbortController();
    const finish = (result?: Outcome) => {
      clearTimeout(timer);
      caller.removeEventListener('abort', fail);
      resolve(result);
    };
    const fail = () => {
      controller.abort();
      finish();
    };
    const outgoing = request(new URL('/hash', origin), {
      method: 'POST', agent: false, maxHeaderSize: 8192, signal: controller.signal,
      headers: {'content-type': 'application/json;charset=utf-8', 'content-length': Buffer.byteLength(json)},
    }, response => {
      const status = response.statusCode;
      if ((status !== 200 && status !== 502 && status !== 503 && status !== 504) ||
          !framing(response, true)) return fail();
      void readJson(response, deadline, controller.signal).then(body => {
        const outcome = performance.now() < deadline ? classify(status, body) : undefined;
        if (outcome) finish(outcome);
        else fail();
      }, fail);
    });
    outgoing.maxHeadersCount = 0;
    outgoing.on('error', fail);
    outgoing.once('upgrade', (_response, socket) => {
      socket.destroy();
      fail();
    });
    const timer = setTimeout(fail, 500);
    caller.addEventListener('abort', fail, {once: true});
    if (caller.aborted) fail();
    else outgoing.end(json);
  });
}

if (import.meta.main) {
  const origin = computeOrigin(process.env.COMPUTE_ORIGIN);
  const shutdown = new AbortController();
  let active = 0;
  serve(() => ({ok: true, active}), async (body, response, caller) => {
    const input = parseInput(body);
    if (!input) return problem(response, 400, 'invalid_request');
    if (active >= 8) return problem(response, 503, 'busy');
    active++;
    try {
      const result = await forward(origin, input, AbortSignal.any([caller, shutdown.signal]));
      if (result?.status === 200) reply(response, 200, {digest: result.digest});
      else problem(response, result?.status ?? 502, result?.code ?? 'upstream_failure');
    } finally {
      active--;
    }
  }, async () => shutdown.abort());
}
