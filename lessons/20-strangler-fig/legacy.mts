import { startProvider } from './provider.mts';
export async function main() { return startProvider('legacy'); }
if (import.meta.main) await main();
