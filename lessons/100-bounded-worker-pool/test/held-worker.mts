import {isMainThread, parentPort, workerData} from 'node:worker_threads';
import {exact, parseInput} from '../schema.mts';
import {hash} from '../worker.mts';

if (!isMainThread && parentPort && workerData === 'hold-fixture') {
  const port = parentPort;
  port.on('message', (value: unknown) => {
    if (!exact(value, ['id', 'input']) || typeof value.id !== 'string') throw new Error('invalid job');
    const input = parseInput(value.input);
    if (!input) throw new Error('invalid input');
    if (input.text !== 'hold') port.postMessage({id: value.id, digest: hash(input.text, input.iterations)});
  });
}
