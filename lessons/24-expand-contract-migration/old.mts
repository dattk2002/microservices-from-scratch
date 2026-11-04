import { start } from './service.mts';
export async function main() { return start('old'); }
if (import.meta.main) await main();
