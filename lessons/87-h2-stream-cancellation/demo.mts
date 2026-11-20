import { constants } from 'node:http2';
import { deferred } from './deferred.mts';
import { DEADLINE_MS, MAX_BYTES, MAX_SESSIONS, fault, readResponse, validFastBody } from './protocol.mts';

const { NGHTTP2_CANCEL, NGHTTP2_NO_ERROR } = constants;
export interface StreamEvents {
  headers(raw: readonly string[], endStream: boolean): void;
  data(chunk: Buffer): void;
  extraHeaders(): void;
  end(): void;
  close(rstCode: number): void;
  error(): void;
}

export interface DemoStream {
  readonly closed: boolean;
  close(code: number): void;
}

export interface DemoSession {
  open(path: '/slow' | '/fast', events: StreamEvents): DemoStream;
  destroy(): void;
  readonly closed: Promise<void>;
}

export type OpenSession = (onFailure: () => void) => DemoSession;
export type DemoResult = { fast: 'ok'; cancelled: true };

export function createDemoRunner(openSession: OpenSession, now = () => performance.now()) {
  let active = 0;

  return async (signal: AbortSignal): Promise<DemoResult> => {
    if (active >= MAX_SESSIONS) throw fault(503, 'busy');
    active += 1;
    let session: DemoSession | undefined;
    const deadline = now() + DEADLINE_MS;
    const result = deferred<DemoResult>();
    let finished = false;
    let startFast: NodeJS.Immediate | undefined;

    function fail() {
      if (finished) return;
      finished = true;
      result.reject(fault(502, 'upstream_failure'));
    }

    const timer = setTimeout(fail, DEADLINE_MS);
    signal.addEventListener('abort', fail, { once: true });
    try {
      if (signal.aborted) fail();
      else {
        try {
          session = openSession(fail);
          runOnSession(session);
        } catch {
          fail();
        }
      }
      return await result.promise;
    } finally {
      clearTimeout(timer);
      if (startFast !== undefined) clearImmediate(startFast);
      signal.removeEventListener('abort', fail);
      if (session) {
        // Keep the permit until transport cleanup has reached its close event.
        void session.closed.then(() => { active -= 1; });
        session.destroy();
      } else {
        active -= 1;
      }
    }

    function runOnSession(session: DemoSession) {
      let slowHeaders = false;
      let localReset = false;
      let slowCancelled = false;
      let fastHeaders = false;
      let fastEOF = false;
      let fastClosed = false;
      let expectedLength: number | undefined;
      let bytes = 0;
      const chunks: Buffer[] = [];

      function completeIfReady() {
        if (finished || !slowCancelled || !fastEOF || !fastClosed) return;
        if (signal.aborted || now() >= deadline) {
          fail();
          return;
        }
        finished = true;
        result.resolve({ fast: 'ok', cancelled: true });
      }

      const fastEvents: StreamEvents = {
        headers(raw) {
          if (finished) return;
          if (fastHeaders) return fail();
          try {
            expectedLength = readResponse(raw);
            fastHeaders = true;
          } catch {
            fail();
          }
        },
        data(chunk) {
          if (finished) return;
          bytes += chunk.length;
          if (!fastHeaders || bytes > MAX_BYTES ||
              (expectedLength !== undefined && bytes > expectedLength)) return fail();
          chunks.push(chunk);
        },
        extraHeaders: fail,
        end() {
          if (finished) return;
          if (!fastHeaders || (expectedLength !== undefined && expectedLength !== bytes)) return fail();
          try {
            if (!validFastBody(Buffer.concat(chunks, bytes))) return fail();
          } catch {
            return fail();
          }
          fastEOF = true;
          completeIfReady();
        },
        close(code) {
          if (code !== NGHTTP2_NO_ERROR || !fastEOF) return fail();
          fastClosed = true;
          completeIfReady();
        },
        error: fail,
      };

      function unexpectedSlowEvent() {
        if (!localReset) fail();
      }

      const slow = session.open('/slow', {
        headers(raw, endStream) {
          if (finished) return;
          if (slowHeaders || endStream) return fail();
          try {
            readResponse(raw);
          } catch {
            return fail();
          }
          slowHeaders = true;
          // Let already-dispatched stream events run before making the reset.
          startFast = setImmediate(() => {
            if (finished || slow.closed || now() >= deadline) return fail();
            try {
              session.open('/fast', fastEvents);
              if (finished) return;
              localReset = true;
              slow.close(NGHTTP2_CANCEL);
            } catch {
              fail();
            }
          });
        },
        data: unexpectedSlowEvent,
        extraHeaders: unexpectedSlowEvent,
        end: unexpectedSlowEvent,
        close(code) {
          if (!localReset || code !== NGHTTP2_CANCEL) return fail();
          slowCancelled = true;
          completeIfReady();
        },
        error: fail,
      });
    }
  };
}
