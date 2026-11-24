export type Variant = 'application/json' | 'text/plain';
export type Range = Readonly<{ media: string; quality: number }>;

const variants: readonly Variant[] = ['application/json', 'text/plain'];
const token = "[!#$%&'+.^_`|~0-9a-z-]+";
const rangeSyntax = new RegExp(
  `^[ \t]*(\\*/\\*|${token}/(?:\\*|${token}))[ \t]*(?:;[ \t]*q=(0(?:\\.[0-9]{0,3})?|1(?:\\.0{0,3})?)[ \t]*)?$`,
  'i',
);

// Only ASCII SP and HTAB can be whitespace. In particular, JS trim() is too broad.
export function parseAccept(value: string | undefined): readonly Range[] {
  const input = value ?? '*/*';
  if (input.length > 1024 || /[^\t\x20-\x7e]/.test(input)) throw new Error('invalid_accept');
  const fields = input.split(',');
  if (fields.length > 16) throw new Error('invalid_accept');

  const seen = new Set<string>();
  return fields.map(field => {
    const match = rangeSyntax.exec(field);
    const media = match?.[1]?.toLowerCase();
    if (!media || seen.has(media)) throw new Error('invalid_accept');
    seen.add(media);
    return { media, quality: Math.round(Number(match?.[2] ?? '1') * 1000) };
  });
}

function effective(variant: Variant, ranges: readonly Range[]) {
  const typeWildcard = variant.slice(0, variant.indexOf('/')) + '/*';
  const candidates = [variant, typeWildcard, '*/*'];
  for (const [index, media] of candidates.entries()) {
    const match = ranges.find(range => range.media === media);
    if (match) return { quality: match.quality, specificity: 2 - index };
  }
  return { quality: 0, specificity: -1 };
}

export function isAcceptable(variant: Variant, ranges: readonly Range[]): boolean {
  return effective(variant, ranges).quality > 0;
}

export function chooseVariant(ranges: readonly Range[]): Variant | undefined {
  let winner: Variant | undefined;
  let best = { quality: 0, specificity: -1 };
  for (const variant of variants) {
    const score = effective(variant, ranges);
    if (score.quality > 0 && (score.quality > best.quality ||
      (score.quality === best.quality && score.specificity > best.specificity))) {
      winner = variant;
      best = score;
    }
  }
  return winner;
}
