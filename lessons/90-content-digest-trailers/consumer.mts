import { json, numberSetting } from '../../lib/http.mts';
import { ingestBlob } from './digest.mts';
import { pathOf, problem, requireBodyless, serve } from './http.mts';
import { prepareReceipts } from './store.mts';
import { normalizeProducerOrigin, requestBlob } from './upstream.mts';

const MAX_ACTIVE_CALLS = 8;

async function main(): Promise<void> {
  const port = numberSetting('PORT', 4090, 0, 65_535);
  const origin = normalizeProducerOrigin(process.env.PRODUCER_ORIGIN ?? 'http://127.0.0.1:3090');
  const dbPath = process.env.DB_PATH;
  if (!dbPath?.trim() || dbPath === ':memory:' || /^file:/i.test(dbPath)) {
    throw new Error('DB_PATH must name a private SQLite file');
  }

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath, {timeout: 0});
  try {
    const receipts = prepareReceipts(db);
    let active = 0;
    await serve('consumer', port, async (req, res, shutdown) => {
      const path = pathOf(req);
      if (path === '/receipt') {
        requireBodyless(req, res, 'GET');
        const receipt = receipts.read();
        if (!receipt) problem(404, 'no_receipt');
        json(res, 200, receipt);
        return;
      }

      if (path !== '/ingest') problem(404, 'not_found');
      requireBodyless(req, res, 'POST');
      if (active >= MAX_ACTIVE_CALLS) problem(503, 'busy');
      const caller = new AbortController();
      const disconnect = () => {
        if (!res.writableFinished) caller.abort();
      };
      active++;
      try {
        // The inbound request itself normally ends before the outbound exchange does.
        res.once('close', disconnect);
        if (res.destroyed) disconnect();
        const signal = AbortSignal.any([caller.signal, shutdown]);
        const receipt = await ingestBlob(
          (verification, attemptSignal) => requestBlob(origin, verification, attemptSignal),
          receipts.commit,
          signal,
        );
        json(res, 200, receipt);
      } finally {
        res.off('close', disconnect);
        active--;
      }
    });
  } finally {
    db.close();
  }
}

if (import.meta.main) await main();
