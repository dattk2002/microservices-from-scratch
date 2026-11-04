import { start } from './service.mts';
export async function main() { return start('new'); }
if (import.meta.main) await main();
