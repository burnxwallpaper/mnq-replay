import type { EquityPoint } from "@/lib/strategy-script";

/** One date (or clock) label on the equity chart's horizontal axis. Times are UTC, matching bar timestamps. */
export type EquityAxisTick = {
  /** 0 at the first timestamp, 1 at the last. */
  fraction: number;
  ts: number;
  label: string;
  align: "start" | "middle" | "end";
};

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const monthDay = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
});

const monthDayYear = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  year: "numeric",
});

const monthDayClock = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function axisLabel(ts: number, span: number, multiYear: boolean, isLast: boolean) {
  if (span < 2 * DAY_MS) {
    const clock = monthDayClock.format(new Date(ts));
    return isLast ? `${clock} UTC` : clock;
  }
  if (multiYear || isLast) {
    const dated = monthDayYear.format(new Date(ts));
    return isLast ? `${dated} UTC` : dated;
  }
  return monthDay.format(new Date(ts));
}

/** Approximate advance of 11px ui-monospace, used to keep tick labels from colliding. */
function labelWidth(label: string) {
  return label.length * 6.6;
}

function tickBox(tick: EquityAxisTick, innerWidth: number) {
  const x = tick.fraction * innerWidth;
  const width = labelWidth(tick.label);
  if (tick.align === "start") return { left: x, right: x + width };
  if (tick.align === "end") return { left: x - width, right: x };
  return { left: x - width / 2, right: x + width / 2 };
}

function dropOverlaps(ticks: EquityAxisTick[], innerWidth: number) {
  if (ticks.length <= 2) return ticks;
  const first = ticks[0];
  const last = ticks[ticks.length - 1];
  if (!first || !last) return ticks;
  const gap = 8;
  const kept: EquityAxisTick[] = [first];
  const lastBox = tickBox(last, innerWidth);
  for (const tick of ticks.slice(1, -1)) {
    const prev = kept[kept.length - 1];
    if (!prev) continue;
    const prevBox = tickBox(prev, innerWidth);
    const nextBox = tickBox(tick, innerWidth);
    if (nextBox.left < prevBox.right + gap) continue;
    if (nextBox.right > lastBox.left - gap) continue;
    kept.push(tick);
  }
  kept.push(last);
  return kept;
}

/**
 * Date ticks for the equity curve's horizontal axis.
 * `innerWidth` is the plot width in CSS pixels so labels stay apart at 11px.
 */
export function equityAxisTicks(t0: number, t1: number, innerWidth: number): EquityAxisTick[] {
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || innerWidth <= 0) return [];
  const span = Math.max(0, t1 - t0);
  const multiYear = new Date(t0).getUTCFullYear() !== new Date(t1).getUTCFullYear();
  if (span <= 0) {
    return [
      {
        fraction: 0,
        ts: t0,
        label: axisLabel(t0, span, multiYear, true),
        align: "start",
      },
    ];
  }

  const target = span >= 180 * DAY_MS ? 6 : 5;
  const candidates: number[] = [];
  for (let index = 0; index < target; index += 1) {
    candidates.push(t0 + (span * index) / (target - 1));
  }

  const snapToUtcDay = span >= 3 * DAY_MS;
  const snapped = candidates.map((ts, index) => {
    if (!snapToUtcDay || index === 0 || index === candidates.length - 1) return ts;
    const date = new Date(ts);
    const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    if (midnight <= t0 + HOUR_MS || midnight >= t1 - HOUR_MS) return ts;
    return midnight;
  });

  const minSep = span * 0.12;
  const unique: number[] = [];
  for (const ts of snapped) {
    const prev = unique[unique.length - 1];
    if (prev !== undefined && ts - prev < minSep) continue;
    unique.push(ts);
  }
  const tail = unique[unique.length - 1];
  if (tail === undefined) unique.push(t1);
  else if (t1 - tail >= minSep) unique.push(t1);
  else unique[unique.length - 1] = t1;
  if (unique[0] !== t0) unique[0] = t0;

  const ticks: EquityAxisTick[] = unique.map((ts, index) => {
    const isFirst = index === 0;
    const isLast = index === unique.length - 1;
    return {
      fraction: (ts - t0) / span,
      ts,
      label: axisLabel(ts, span, multiYear, isLast),
      align: isFirst ? "start" : isLast ? "end" : "middle",
    };
  });
  return dropOverlaps(ticks, innerWidth);
}

/** Step value of the equity curve at `ts` (holds the previous point until the next). */
export function equityAt(points: readonly EquityPoint[], ts: number): number | null {
  const first = points[0];
  if (!first || ts < first.ts) return null;
  let value = first.equity;
  for (const point of points) {
    if (point.ts > ts) break;
    value = point.equity;
  }
  return value;
}
