/** Standard EMA. Index length-1 is the SMA seed; earlier indexes are null. */
export function ema(values: readonly number[], length: number): (number | null)[] {
  const out: (number | null)[] = values.map(() => null);
  const period = Math.floor(length);
  if (period < 1 || values.length < period) return out;
  let sum = 0;
  for (let index = 0; index < period; index += 1) sum += values[index];
  let previous = sum / period;
  out[period - 1] = previous;
  const weight = 2 / (period + 1);
  for (let index = period; index < values.length; index += 1) {
    previous = values[index] * weight + previous * (1 - weight);
    out[index] = previous;
  }
  return out;
}
