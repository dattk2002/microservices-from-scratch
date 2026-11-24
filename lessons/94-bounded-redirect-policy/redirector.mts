import { targetOrigin } from './policy.mts';
import { serve } from './server.mts';

async function main(): Promise<void> {
  const destination = targetOrigin(process.env.TARGET_ORIGIN) + '/resource';
  await serve('redirector', 8095, '/start', res => {
    res.writeHead(302, {'location': destination, 'content-length': 0}).end();
  });
}

if (import.meta.main) await main();
