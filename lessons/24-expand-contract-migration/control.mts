import { start } from './service.mts';
export async function main() { return start('control'); }
if (import.meta.main) await main();
