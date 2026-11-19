import assert from 'node:assert/strict';
import type { OutgoingHttpHeader, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { serve } from '../../../lib/http.mts';
import { databasePath } from '../contracts.mts';
import { handleFeedRequest } from '../feed.mts';
import { FeedStore } from '../store.mts';

export function commitOnReplayHeaders(res: ServerResponse, store: FeedStore): void {
  const writeHead = res.writeHead.bind(res);
  res.writeHead = (status: number, messageOrHeaders?: string | OutgoingHttpHeaders | OutgoingHttpHeader[],
    headers?: OutgoingHttpHeaders | OutgoingHttpHeader[]) => {
    const response = typeof messageOrHeaders === 'string'
      ? writeHead(status, messageOrHeaders, headers) : writeHead(status, messageOrHeaders);
    if (status === 200) {
      // Force the first HTTP write, then commit before the handler sends the SSE body.
      response.flushHeaders();
      assert.deepEqual(store.append({id: 'e', text: 'Fifth'}), {created: true, sequence: 5});
    }
    return response;
  };
}

async function main(): Promise<void> {
  const path = databasePath(process.env.DB_PATH);
  const {DatabaseSync} = await import('node:sqlite');
  const db = new DatabaseSync(path);
  try {
    const store = new FeedStore(db);
    const server = await serve('pinned-feed-test', 8081, (req, res) => {
      if (req.method === 'GET' && req.url === '/events' && req.headers['last-event-id'] === '2') {
        commitOnReplayHeaders(res, store);
      }
      return handleFeedRequest(store, req, res);
    });
    server.once('close', () => db.close());
  } catch (error) {
    db.close();
    throw error;
  }
}

if (import.meta.main) await main();
