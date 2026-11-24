import { lstatSync } from 'node:fs';
import { configuredSocket, json, runDirectly, serve } from './http.mts';

async function main(): Promise<void> {
  const path = configuredSocket();
  if (lstatSync(path, { throwIfNoEntry: false }) !== undefined) {
    throw new Error('provider.sock already exists; inspect it before attempting recovery');
  }
  await serve({ path }, ['/value'], (_route, res) => {
    json(res, 200, { value: 'local-only' });
  });
}

runDirectly(import.meta.url, main);
