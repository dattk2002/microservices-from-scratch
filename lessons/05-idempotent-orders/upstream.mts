import { HttpError } from '../../lib/http.mts';
import { parseProduct } from './contract.mts';
import type { Product } from './contract.mts';

export async function fetchProduct(origin: URL, productId: string, timeout: number): Promise<Product> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(new URL(`/products/${productId}`, origin), {
      signal: controller.signal, redirect: 'error',
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      if (response.status === 404) throw new HttpError(422, 'unknown_product', 'Product does not exist');
      throw new HttpError(502, 'catalog_bad_status', 'Unexpected Catalog status');
    }
    if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      await response.body?.cancel();
      throw new HttpError(502, 'catalog_invalid_response', 'Expected Catalog JSON');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new HttpError(502, 'catalog_invalid_response', 'Missing Catalog body');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 8192) {
          await reader.cancel();
          throw new HttpError(502, 'catalog_invalid_response', 'Catalog body exceeds 8192 bytes');
        }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parseProduct(value, productId);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (controller.signal.aborted) throw new HttpError(504, 'catalog_timeout', 'Catalog deadline exceeded');
    if (error instanceof SyntaxError) throw new HttpError(502, 'catalog_invalid_response', 'Catalog JSON is malformed');
    throw new HttpError(503, 'catalog_unavailable', 'Cannot reach Catalog');
  } finally { clearTimeout(timer); }
}
