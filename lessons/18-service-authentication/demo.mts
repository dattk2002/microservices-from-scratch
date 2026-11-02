import { generateKeyPairSync } from 'node:crypto';
import { startService, jsonRequest } from '../../test/support.mts';

export async function main() {
  const pair = generateKeyPairSync('ed25519');
  const resource = await startService(new URL('./resource.mts', import.meta.url), {
    PUBLIC_KEY: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  });
  try {
    const caller = await startService(new URL('./caller.mts', import.meta.url), {
      PRIVATE_KEY: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), RESOURCE_URL: resource.url,
    });
    try {
      const response = await jsonRequest(`${caller.url}/call`, { report: 'monthly' });
      console.log(JSON.stringify({ status: response.status, result: await response.json() }));
      if (response.status !== 200) throw new Error('Demo failed');
    } finally { await caller.stop(); }
  } finally { await resource.stop(); }
}
if (import.meta.main) {
  try { await main(); } catch { console.error('Demo failed'); process.exitCode = 1; }
}
