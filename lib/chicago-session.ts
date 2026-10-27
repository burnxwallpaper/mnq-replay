/**
 * America/Chicago wall clock without Intl.
 * US DST since 2007: second Sunday in March 02:00 CST through
 * first Sunday in November 02:00 CDT. Weekday 0 is Sunday.
 * Session windows used by the daytime and eve scripts sit hours away
 * from the 02:00 transition, and this matches Intl on those instants.
 */

const boundsCache = new Map<number, { start: number; end: number }>();

function nthWeekday(year: number, monthIndex: number, weekday: number, n: number): number {
  const firstDow = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
  return 1 + ((weekday - firstDow + 7) % 7) + (n - 1) * 7;
}

export function dstBoundsUtc(year: number): { start: number; end: number } {
  const cached = boundsCache.get(year);
  if (cached) return cached;
  const start = Math.floor(Date.UTC(year, 2, nthWeekday(year, 2, 0, 2), 8, 0, 0) / 1000);
  const end = Math.floor(Date.UTC(year, 10, nthWeekday(year, 10, 0, 1), 7, 0, 0) / 1000);
  const bounds = { start, end };
  boundsCache.set(year, bounds);
  return bounds;
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export type ChicagoParts = {
  mins: number;
  /** 0 = Sunday … 5 = Friday. */
  weekday: number;
  weekdayName: (typeof WEEKDAY_NAMES)[number];
};

/** `unixSec` is bar open time in unix seconds. */
export function chicagoParts(unixSec: number): ChicagoParts {
  const year = new Date(unixSec * 1000).getUTCFullYear();
  const bounds = dstBoundsUtc(year);
  const offset = unixSec >= bounds.start && unixSec < bounds.end ? -5 * 3600 : -6 * 3600;
  const local = unixSec + offset;
  const mins = ((Math.floor(local / 60) % 1440) + 1440) % 1440;
  const days = Math.floor(local / 86400);
  const weekday = ((days + 4) % 7 + 7) % 7;
  return { mins, weekday, weekdayName: WEEKDAY_NAMES[weekday] ?? "Sun" };
}

/** Daytime script: 09:00–20:29 CT, and no new Friday entries from 14:45. */
export function isDaySession(mins: number, weekday: number): boolean {
  return mins >= 9 * 60 && mins < 21 * 60 - 30 && !(weekday === 5 && mins >= 14 * 60 + 45);
}

/** Eve script: 20:30–23:59 CT inclusive. No Friday cutoff. */
export function isEveSession(mins: number): boolean {
  return mins >= 20 * 60 + 30 && mins <= 23 * 60 + 59;
}

/** Fills 1/0 masks. `tsMs` is bar open time in unix milliseconds. */
export function fillSessionMasks(tsMs: ArrayLike<number>, day: Uint8Array, eve: Uint8Array): void {
  const n = Math.min(tsMs.length, day.length, eve.length);
  let year = -1;
  let yearStart = 0;
  let nextYear = 0;
  let dstStart = 0;
  let dstEnd = 0;
  for (let i = 0; i < n; i += 1) {
    const sec = Math.floor(tsMs[i] / 1000);
    if (year < 0 || sec < yearStart || sec >= nextYear) {
      year = new Date(sec * 1000).getUTCFullYear();
      yearStart = Math.floor(Date.UTC(year, 0, 1) / 1000);
      nextYear = Math.floor(Date.UTC(year + 1, 0, 1) / 1000);
      const bounds = dstBoundsUtc(year);
      dstStart = bounds.start;
      dstEnd = bounds.end;
    }
    const offset = sec >= dstStart && sec < dstEnd ? -5 * 3600 : -6 * 3600;
    const local = sec + offset;
    const mins = ((Math.floor(local / 60) % 1440) + 1440) % 1440;
    const days = Math.floor(local / 86400);
    const weekday = ((days + 4) % 7 + 7) % 7;
    day[i] = isDaySession(mins, weekday) ? 1 : 0;
    eve[i] = isEveSession(mins) ? 1 : 0;
  }
}
