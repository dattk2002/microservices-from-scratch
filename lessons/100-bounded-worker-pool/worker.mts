import {createHash} from 'node:crypto';
import {isMainThread, parentPort, workerData} from 'node:worker_threads';
import {pathToFileURL} from 'node:url';
import {exact, parseInput} from './schema.mts';

export function hash(text: string, iterations: number): string {
  let bytes = Buffer.from(text, 'utf8');
  for (let round = 0; round < iterations; round++) {
    bytes = createHash('sha256').update(bytes).digest();
  }
  return bytes.toString('hex');
}

if (!isMainThread && parentPort && process.argv[1] &&
    pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (workerData !== 'bounded-hash-v1') throw new Error('invalid worker configuration');
  const port = parentPort;
  port.on('message', (value: unknown) => {
    if (!exact(value, ['id', 'input']) || typeof value.id !== 'string' ||
        value.id.length !== 36 || !/^[a-f0-9-]+$/.test(value.id)) throw new Error('invalid job ID');
    const input = parseInput(value.input);
    if (!input) throw new Error('invalid job payload');
    port.postMessage({id: value.id, digest: hash(input.text, input.iterations)});
  });
}
