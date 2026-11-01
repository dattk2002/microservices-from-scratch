import { setTimeout as sleep } from 'node:timers/promises';
import { json, numberSetting } from '../../lib/http.mts';
import { context } from './context.mts';
import { start } from './service.mts';

export async function main() {
  const delay = numberSetting('DELAY_MS', 0, 0, 3000);
  return start('catalog', 4801, async (_req, res) => {
    await sleep(delay);
    json(res, 200, { priceCents: 125, correlationId: context.getStore()!.id });
  });
}
if (import.meta.main) await main();
