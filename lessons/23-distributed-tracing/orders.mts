import { start } from './service.mts';
export async function main() { return start('orders'); }
if (import.meta.main) await main();
