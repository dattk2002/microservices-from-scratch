export function action(state: string): 'reserve' | 'charge' | 'release' | 'done' {
  switch (state) {
    case 'reserving': return 'reserve';
    case 'charging': return 'charge';
    case 'compensating': case 'compensation_failed': return 'release';
    case 'completed': case 'cancelled': return 'done';
    default: throw new Error('Unknown saga state');
  }
}
