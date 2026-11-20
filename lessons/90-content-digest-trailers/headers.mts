export function trimOws(value: string): string {
  return value.replace(/^[ \t]+|[ \t]+$/g, '');
}

export function rawFieldValues(raw: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < raw.length; index += 2) {
    const field = raw[index + 1];
    if (raw[index]?.toLowerCase() === name && field !== undefined) values.push(trimOws(field));
  }
  return values;
}
