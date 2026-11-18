import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, readJson, serve } from '../../../lib/http.mts';
import { exact, invalid } from '../protocol.mts';

const modes = new Set([
  'ok', 'identity', 'wrong-revision', 'rewound', 'cursor-equal', 'unordered', 'unknown',
  'unexpected-code', 'error-array', 'wrong-message', 'unavailable', 'malformed',
  'oversize', 'late-body', 'redirect',
]);

function lateBody(res: ServerResponse, document: string): void {
  // Headers and first byte at 300 ms, then 350 ms to finish. A fresh body budget
  // would allow this response, while the single 500 ms budget must reject it.
  let timer = setTimeout(() => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write(document.slice(0, 1));
    timer = setTimeout(() => res.end(document.slice(1)), 350);
  }, 300);
  res.once('close', () => clearTimeout(timer));
}

async function main(): Promise<void> {
  const shard = process.env.SHARD_ID;
  if (shard !== 'a' && shard !== 'b') throw new Error('Invalid fixture SHARD_ID');
  const redirectOrigin = process.env.REDIRECT_ORIGIN;
  const revision = shard === 'a' ? 2 : 3;
  const items = shard === 'a'
    ? [{ id: 'a1', score: 90 }, { id: 'a2', score: 70 }]
    : [{ id: 'b0', score: 90 }, { id: 'b1', score: 80 }];
  const page = { shard, revision, items };
  const document = JSON.stringify(page);
  let mode = 'ok';
  let received = 0;

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://fixture');
    if (url.pathname === '/stats') {
      json(res, 200, { received });
      return;
    }
    if (url.pathname === '/received') {
      received++;
      json(res, 200, {});
      return;
    }
    if (url.pathname === '/mode' && req.method === 'POST') {
      const body = await readJson(req);
      if (!exact(body, ['mode']) || typeof body.mode !== 'string' || !modes.has(body.mode)) invalid();
      mode = body.mode;
      json(res, 200, { mode });
      return;
    }
    if (url.pathname !== `/snapshots/${revision}/page` || url.searchParams.size !== 3 ||
        url.searchParams.get('limit') !== '2' || url.searchParams.get('afterScore') !== '90' ||
        url.searchParams.get('afterId') !== 'a0') invalid();

    switch (mode) {
      case 'identity': json(res, 200, { ...page, shard: shard === 'a' ? 'b' : 'a' }); return;
      case 'wrong-revision': json(res, 200, { ...page, revision: revision - 1 }); return;
      case 'rewound': json(res, 200, { ...page, items: [{ id: shard + '7', score: 91 }] }); return;
      case 'cursor-equal': json(res, 200, { ...page, items: [{ id: 'a0', score: 90 }] }); return;
      case 'unordered': json(res, 200, { ...page, items: items.toReversed() }); return;
      case 'unknown': json(res, 404, { error: { code: 'unknown_snapshot', message: 'unknown_snapshot' } }); return;
      case 'unexpected-code': json(res, 404, { error: { code: 'internal_error', message: 'internal_error' } }); return;
      case 'wrong-message': json(res, 404, { error: { code: 'unknown_snapshot', message: 'wrong' } }); return;
      case 'error-array': json(res, 404, { error: [] }); return;
      case 'unavailable': json(res, 503, page); return;
      case 'malformed':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{');
        return;
      case 'oversize':
        // Whitespace alone takes the unchanged, otherwise-valid JSON past the cap.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write(document);
        res.end(' '.repeat(8193 - Buffer.byteLength(document)));
        return;
      case 'late-body': lateBody(res, document); return;
      case 'redirect':
        if (!redirectOrigin) throw new Error('Fixture redirect origin required');
        res.writeHead(307, { location: redirectOrigin + '/received' });
        res.end();
        return;
      default: json(res, 200, page);
    }
  };
  await serve('keyset-fixture', 0, handler);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Fixture startup failed');
    process.exitCode = 1;
  });
}
