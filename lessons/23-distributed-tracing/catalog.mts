import { start } from './service.mts';
export async function main() { return start('catalog'); }
if (import.meta.main) await main();
