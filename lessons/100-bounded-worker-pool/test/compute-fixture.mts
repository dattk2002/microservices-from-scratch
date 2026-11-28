import {Worker} from 'node:worker_threads';
import {setTimeout as delay} from 'node:timers/promises';
import {startCompute} from '../compute.mts';
import {Pool} from '../pool.mts';

class HeldWorker extends Worker {
  override async terminate(): Promise<number> {
    // Keep the retiring slot unavailable while the burst's queued deadlines expire.
    await delay(120);
    return super.terminate();
  }
}

if (import.meta.main) {
  await startCompute(new Pool(() => new HeldWorker(new URL('./held-worker.mts', import.meta.url), {
    workerData: 'hold-fixture',
    resourceLimits: {maxOldGenerationSizeMb: 32, stackSizeMb: 2},
  })));
}
