export type Phase = 'legacy-only' | 'copy-cutover' | 'extracted-owner';
export function parsePhase(value: unknown): Phase {
  if (value === 'legacy-only' || value === 'copy-cutover' || value === 'extracted-owner') return value;
  throw new Error('Invalid durable phase');
}
export function transition(from: Phase, to: Phase): Phase {
  if (from === to || (from === 'legacy-only' && to === 'copy-cutover')
      || (from === 'copy-cutover' && to === 'extracted-owner')) return to;
  throw new Error(`Illegal ownership transition ${from} -> ${to}`);
}
export function owner(phase: Phase): 'legacy' | 'extracted' | undefined {
  return phase === 'legacy-only' ? 'legacy' : phase === 'extracted-owner' ? 'extracted' : undefined;
}
export function recovery(phase: Phase): string {
  return phase === 'legacy-only' ? 'serve-legacy' : phase === 'copy-cutover'
    ? 'freeze-copy-validate-activate' : 'serve-extracted';
}
