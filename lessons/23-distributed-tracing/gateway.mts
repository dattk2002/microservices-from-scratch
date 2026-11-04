import { start } from './service.mts';
export async function main() { return start('gateway'); }
if (import.meta.main) await main();
