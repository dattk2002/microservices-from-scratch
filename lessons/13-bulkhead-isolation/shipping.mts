import { startDownstream } from './downstream.mts';
if (import.meta.main) await startDownstream('shipping', 4312);
