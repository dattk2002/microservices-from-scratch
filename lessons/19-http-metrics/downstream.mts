import { start } from './service.mts';
export async function main() { return start('downstream'); }
if (import.meta.main) await main();
