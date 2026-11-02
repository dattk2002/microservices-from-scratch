import { startProvider } from './provider.mts';
export async function main() { return startProvider('extracted'); }
if (import.meta.main) await main();
