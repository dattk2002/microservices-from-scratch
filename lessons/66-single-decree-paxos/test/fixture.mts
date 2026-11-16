import { createServer } from 'node:http';
import type { Server, RequestListener } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { HttpError, json, readJson } from '../../../lib/http.mts';
import { AcceptorStore } from '../store.mts';
import { exact, fail, ids, request } from '../protocol.mts';
import type { Id } from '../protocol.mts';

const modes = ['valid', 'null', 'array', 'primitive', 'extra', 'duplicate', 'stale', 'wrong-field', 'wrong-value', 'unexpected-error', 'invalid-error', 'conflict', 'oversize', 'invalid-json', 'content-type', 'redirect', 'escaped', 'lost', 'hang', 'delay'];
function escapeTokens(value: unknown): string {
  const source = JSON.stringify(value);
  if (source === undefined) throw new Error('JSON value required');
  return source.replace(/"(?:[^"\\]|\\.)*"/g, token => {
    const decoded: unknown = JSON.parse(token);
    if (typeof decoded !== 'string') throw new Error('Expected string token');
    return '"' + [...decoded].map(c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('') + '"';
  });
}
export async function main() {
  const { DatabaseSync } = await import('node:sqlite');
  const servers: Server[] = []; const databases: DatabaseSync[] = [];
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return; cleaned = true;
    for (const server of servers) server.closeAllConnections();
    try { await Promise.all(servers.map(server => new Promise<void>(resolve => { if (!server.listening) resolve(); else server.close(() => resolve()); }))); }
    finally { for (const db of databases) db.close(); }
  };
  try {
    const replica = (id: Id) => { const db = new DatabaseSync(':memory:'); databases.push(db); return new AcceptorStore(db, id); };
    const stores = { a: replica('a'), b: replica('b'), c: replica('c') };
    const prepares = { a: 0, b: 0, c: 0 }; const accepts = { a: 0, b: 0, c: 0 };
    let sink = 0; let mode = 'valid'; let stage = '/prepare';
    const topology = { a: '', b: '', c: '', sink: '' };
    const listen = async (handler: RequestListener) => {
      const server = createServer(handler); servers.push(server);
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('TCP address required');
      return `http://127.0.0.1:${address.port}`;
    };
    topology.sink = await listen((req, res) => { if (req.url !== '/health') sink++; json(res, 200, {}); });
    for (const id of ids) {
      topology[id] = await listen((req, res) => {
        void (async () => {
          if (req.method === 'GET' && req.url === '/topology') return json(res, 200, topology);
          if (req.method === 'GET' && req.url === '/stats') return json(res, 200, { sink, prepares, accepts, states: { a: stores.a.state(), b: stores.b.state(), c: stores.c.state() } });
          if (req.method === 'POST' && req.url === '/control') {
            const b = await readJson(req);
            if (!exact(b, ['mode', 'stage']) || typeof b.mode !== 'string' || !modes.includes(b.mode) || (b.stage !== '/prepare' && b.stage !== '/accept')) fail(400, 'invalid_body');
            mode = b.mode; stage = b.stage; return json(res, 200, { mode, stage });
          }
          if (req.method !== 'POST' || (req.url !== '/prepare' && req.url !== '/accept')) fail(404, 'not_found');
          const path = req.url;
          if (path === '/prepare') prepares[id]++; else accepts[id]++;
          const raw = await readJson(req);
          const b = path === '/prepare' ? request(raw, false) : request(raw, true);
          const selectedMode = mode;
          const affected = id !== 'a' && path === stage;
          if (affected && selectedMode === 'lost' && id === 'c') return json(res, 503, { error: { code: 'unavailable', message: 'unavailable' } });
          const result = path === '/prepare' ? stores[id].prepare(b.ballot) : stores[id].accept(b.ballot, 'value' in b && b.value === 'red' ? 'red' : 'blue');
          const emit = () => {
            if (res.destroyed) return;
            if (!affected || selectedMode === 'valid' || selectedMode === 'delay') return json(res, 200, result);
            if (selectedMode === 'lost') { res.destroy(); return; }
            if (selectedMode === 'hang') {
              res.writeHead(200, { 'content-type': 'application/json' }); res.write(JSON.stringify(result)); return;
            }
            if (selectedMode === 'redirect') { res.writeHead(307, { location: topology.sink + '/destination' }); res.end(); return; }
            if (selectedMode === 'unexpected-error') return json(res, 409, { error: { code: 'internal_error', message: 'internal_error' } });
            if (selectedMode === 'invalid-error') return json(res, 409, { error: [] });
            if (selectedMode === 'conflict') return json(res, 409, { error: { code: 'ballot_conflict', message: 'ballot_conflict' } });
            if (selectedMode === 'null') return json(res, 200, null);
            if (selectedMode === 'array') return json(res, 200, [result]);
            if (selectedMode === 'primitive') return json(res, 200, true);
            if (selectedMode === 'extra') return json(res, 200, { ...result, extra: true });
            if (selectedMode === 'duplicate') return json(res, 200, { ...result, id: 'a' });
            if (selectedMode === 'stale') return json(res, 200, { ...result, ballot: b.ballot - 1 });
            if (selectedMode === 'wrong-field') return json(res, 200, { ...result, ok: 'true' });
            if (selectedMode === 'wrong-value') return json(res, 200, { ...result, accepted: { ballot: b.ballot, value: result.accepted?.value === 'red' ? 'blue' : 'red' } });
            if (selectedMode === 'content-type') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(JSON.stringify(result)); return; }
            const wire = selectedMode === 'escaped' ? escapeTokens(result) : selectedMode === 'oversize' ? JSON.stringify(result).padEnd(8193, ' ') : '{invalid';
            res.writeHead(200, { 'content-type': 'application/json' }); res.end(wire);
          };
          if (selectedMode === 'delay') {
            const timer = setTimeout(emit, 150); res.once('close', () => clearTimeout(timer));
          } else emit();
        })().catch((error: unknown) => {
          if (res.destroyed || res.writableEnded) return;
          if (error instanceof HttpError) json(res, error.status, { error: { code: error.code, message: error.message } });
          else json(res, 500, { error: { code: 'internal_error', message: 'internal_error' } });
        });
      });
    }
    const onSignal = () => { void cleanup(); };
    process.once('SIGTERM', onSignal); process.once('SIGINT', onSignal);
    console.log(JSON.stringify({ service: 'paxos-test-fixture', port: Number(new URL(topology.a).port) }));
  } catch (error) { await cleanup(); throw error; }
}
if (import.meta.main) await main();
