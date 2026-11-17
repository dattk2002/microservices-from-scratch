// Test peer: independent loopback process, with no external traffic or DB.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { serve, json, readJson } from '../../../lib/http.mts';
import { exact, identity, invalid, semantic, emptyCells } from '../protocol.mts';
import { normalizeOrigin } from '../aggregate.mts';

const modes = new Set(['ok', 'null', 'array', 'primitive', 'extra', 'identity', 'dimensions', 'rowsum', 'version', 'cell', 'total',
  'status404', 'status409', 'status422', 'status429', 'status503', 'error-primitive', 'error-array', 'error-extra', 'unexpected-code',
  'oversize', 'chunked-oversize', 'error-oversize', 'escaped', 'media', 'utf8', 'json', 'disconnect', 'redirect',
  'slow-headers', 'slow-body', 'error-slow-body', 'slow-stages']);

function escapedStrings(data: unknown): string {
  // Only decoded JSON STRING tokens are re-encoded. Numeric cells, booleans and
  // null remain valid JSON tokens; escaping all letters/digits corrupts JSON.
  return JSON.stringify(data).replace(/"(?:[^"\\]|\\.)*"/g, token => {
    const value: unknown = JSON.parse(token);
    if (typeof value !== 'string') throw new Error('Expected string token');
    return '"' + Array.from(value, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('') + '"';
  });
}
async function delay(res: ServerResponse, ms: number): Promise<void> {
  await new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); res.off('close', done); resolve(); };
    const timer = setTimeout(done, ms);
    res.once('close', done);
  });
}

export async function main(): Promise<void> {
  const sink = process.env.FIXTURE_ROLE === 'sink';
  const id = process.env.SKETCH_ID;
  if (!sink && !identity(id)) throw new Error('SKETCH_ID required');
  const redirect = sink ? undefined : normalizeOrigin(process.env.REDIRECT_ORIGIN ?? '');
  let mode = 'ok', received = 0;
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://fixture');
    if (url.pathname === '/stats' && req.method === 'GET') { json(res, 200, { received }); return; }
    if (url.pathname === '/mode' && req.method === 'POST' && !sink) {
      const body = await readJson(req);
      if (!exact(body, ['mode']) || typeof body.mode !== 'string' || !modes.has(body.mode)) invalid();
      mode = body.mode; json(res, 200, { mode }); return;
    }
    if (sink) { received++; json(res, 200, {}); return; }
    if (url.pathname !== '/snapshot' || req.method !== 'GET') semantic(404, 'not_found');
    const valid = { id, version: 0, total: 0, cells: emptyCells() };
    let data: unknown = valid, status = 200;
    if (mode === 'redirect') { res.writeHead(307, { location: redirect + '/received' }); res.end(); return; }
    if (mode === 'disconnect') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); res.socket?.destroy(); return; }
    if (mode === 'null') data = null;
    if (mode === 'array') data = [];
    if (mode === 'primitive') data = true;
    if (mode === 'extra') data = { ...valid, extra: 1 };
    if (mode === 'identity') data = { ...valid, id: id === 'a' ? 'b' : 'a' };
    if (mode === 'dimensions') data = { ...valid, cells: [[], [], []] };
    if (mode === 'rowsum') data = { ...valid, cells: [[1, ...Array(15).fill(0)], ...valid.cells.slice(1)] };
    if (mode === 'version') data = { ...valid, version: '0' };
    if (mode === 'cell') data = { ...valid, cells: [[-1, ...Array(15).fill(0)], ...valid.cells.slice(1)] };
    if (mode === 'total') data = { ...valid, total: 1 };
    if (mode.startsWith('status') || mode.startsWith('error-') || mode === 'unexpected-code') {
      status = mode.startsWith('status') ? Number(mode.slice(6)) : 404;
      data = { error: { code: 'internal_error', message: 'internal_error' } };
      if (mode === 'error-primitive') data = { error: true };
      if (mode === 'error-array') data = { error: [] };
      if (mode === 'error-extra') data = { error: { code: 'internal_error', message: 'internal_error', extra: 1 } };
    }
    // Valid schema with valid JSON whitespace; tests the wire-byte limit alone.
    const wire = mode === 'escaped' ? escapedStrings(data) : JSON.stringify(data)
      + (['oversize', 'chunked-oversize', 'error-oversize'].includes(mode) ? ' '.repeat(8192) : '');
    if (mode === 'slow-headers' || mode === 'slow-stages') {
      await delay(res, mode === 'slow-headers' ? 800 : 300);
      if (res.destroyed) return;
    }
    res.writeHead(status, { 'content-type': mode === 'media' ? 'text/plain' : 'application/json' });
    if (mode === 'slow-body' || mode === 'error-slow-body' || mode === 'slow-stages') {
      res.write(wire.slice(0, 1));
      await delay(res, mode === 'slow-stages' ? 300 : 800);
      if (!res.destroyed) res.end(wire.slice(1));
      return;
    }
    if (mode === 'chunked-oversize') { res.write(wire.slice(0, 40)); res.end(wire.slice(40)); return; }
    res.end(mode === 'utf8' ? Buffer.from([0xff]) : mode === 'json' ? '{' : wire);
  };
  await serve('count-min-fixture', 0, handler);
}
if (import.meta.main) main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Startup failed'); process.exitCode = 1;
});
