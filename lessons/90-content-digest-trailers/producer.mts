import { createHash } from 'node:crypto';
import { numberSetting } from '../../lib/http.mts';
import { pathOf, problem, requireBodyless, serve } from './http.mts';

const CHUNKS = [Buffer.of(0x00, 0x41, 0xff), Buffer.of(0x0d, 0x0a, 0x7f)];

async function main(): Promise<void> {
  await serve('producer', numberSetting('PORT', 3090, 0, 65_535), (req, res) => {
    if (pathOf(req) !== '/blob') problem(404, 'not_found');
    requireBodyless(req, res, 'GET');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Transfer-Encoding': 'chunked',
      'Trailer': 'Content-Digest',
    });

    const hash = createHash('sha256');
    for (const chunk of CHUNKS) {
      hash.update(chunk);
      res.write(chunk);
    }
    res.addTrailers({'Content-Digest': `sha-256=:${hash.digest('base64')}:`});
    res.end();
  });
}

if (import.meta.main) await main();
