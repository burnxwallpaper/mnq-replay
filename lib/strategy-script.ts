import { ema } from "@/lib/ema";
import type { OhlcvBar } from "@/lib/strategies/types";

export const STRATEGY_STORAGE_KEY = "mnq-replay.strategyScript";
export const ENTRY_FILTERS_STORAGE_KEY = "mnq-replay.entryFilters";

export type EntryFilters = {
  /** Min body / range ratio, e.g. 0.45 */
  bodyRatio: number;
  /** Min absolute body in index points, e.g. 2 */
  minBody: number;
  /** Volume SMA length, e.g. 15 */
  volLen: number;
  /** Volume must exceed SMA × this, e.g. 1.2 */
  volMult: number;
};

export const DEFAULT_ENTRY_FILTERS: EntryFilters = {
  bodyRatio: 0.45,
  minBody: 2,
  volLen: 15,
  volMult: 1.2,
};

function clampFilters(raw: Partial<EntryFilters> | null | undefined): EntryFilters {
  const base = DEFAULT_ENTRY_FILTERS;
  const num = (value: unknown, fallback: number) => {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  const bodyRatio = Math.min(1, Math.max(0.05, num(raw?.bodyRatio, base.bodyRatio)));
  const minBody = Math.min(200, Math.max(0.25, num(raw?.minBody, base.minBody)));
  const volLen = Math.min(200, Math.max(2, Math.round(num(raw?.volLen, base.volLen))));
  const volMult = Math.min(20, Math.max(0.1, num(raw?.volMult, base.volMult)));
  return { bodyRatio, minBody, volLen, volMult };
}

export function normalizeEntryFilters(raw: Partial<EntryFilters> | null | undefined): EntryFilters {
  return clampFilters(raw);
}

/** Previous on-page defaults. A saved copy of either one upgrades to the current script. */
export const LEGACY_DEFAULT_STRATEGY_SCRIPT = `// MNQ 1-minute strategy. This runs in the browser on each bar.
// bar: { ts, o, h, l, c, v }
// ta.sma(i, length, "o" | "h" | "l" | "c" | "v")
// Return { signal: true, side: "long" | "short", stop, target } or null.
// Entry fills at the signal close. One position at a time.

const avgVol = ta.sma(i, 20, "v")
const body = Math.abs(bar.c - bar.o)
const span = Math.max(bar.h - bar.l, 0.25)
if (bar.c > bar.o && body / span >= 0.55 && body >= 4 && bar.v > avgVol * 1.8) {
  const risk = Math.max(bar.c - bar.l, 1)
  return { signal: true, side: "long", stop: bar.l, target: bar.c + risk * 2 }
}
return null
`;

export const EMA_EXIT_DEFAULT_STRATEGY_SCRIPT = `// MNQ 1-minute strategy. This runs in the browser on each bar.
// bar: { ts, o, h, l, c, v }
// ta.sma / ta.ema(i, length, "o" | "h" | "l" | "c" | "v")
// position: null, or { side, entry, stop, target, risk } while a trade is open
// Return { signal: true, side, stop, target } to enter, { target } to tighten, or null.
// Entry fills at the signal close. One position at a time.
// Impulse entries still target 2R. A close below the 5 EMA tightens that to 1R.

const ema5 = ta.ema(i, 5, "c")
if (position && position.side === "long" && bar.c < ema5) {
  return { target: position.entry + position.risk }
}

const avgVol = ta.sma(i, 20, "v")
const body = Math.abs(bar.c - bar.o)
const span = Math.max(bar.h - bar.l, 0.25)
if (!position && bar.c > bar.o && body / span >= 0.55 && body >= 4 && bar.v > avgVol * 1.8) {
  const risk = Math.max(bar.c - bar.l, 1)
  return { signal: true, side: "long", stop: bar.l, target: bar.c + risk * 2 }
}
return null
`;

export function buildLongStrategyScript(filters: EntryFilters = DEFAULT_ENTRY_FILTERS): string {
  const f = clampFilters(filters);
  return `// MNQ 1-minute strategy. This runs in the browser on each bar.
// bar: { ts, o, h, l, c, v }
// ta.sma / ta.ema(i, length, "o" | "h" | "l" | "c" | "v")
// position: null, or { side, entry, stop, target, risk } while a trade is open
// Return { signal: true, side, stop, target } to enter, { target } to tighten, or null.
// Entry fills at the signal close. One position at a time.
// Impulse entries still target 2R. A close below the 5 EMA tightens that to 1R.
// New longs are skipped from 22:00 through 08:59 Chicago time.
// Filters: body/range >= ${f.bodyRatio}, body >= ${f.minBody}, vol > SMA(${f.volLen}) * ${f.volMult}

const ema5 = ta.ema(i, 5, "c")
if (position && position.side === "long" && bar.c < ema5) {
  return { target: position.entry + position.risk }
}

const ct = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "America/Chicago", hour: "2-digit", hourCycle: "h23" }).format(new Date(bar.ts)))
const sessionOk = ct >= 9 && ct <= 21
const avgVol = ta.sma(i, ${f.volLen}, "v")
const body = Math.abs(bar.c - bar.o)
const span = Math.max(bar.h - bar.l, 0.25)
if (!position && sessionOk && bar.c > bar.o && body / span >= ${f.bodyRatio} && body >= ${f.minBody} && bar.v > avgVol * ${f.volMult}) {
  const risk = Math.max(bar.c - bar.l, 1)
  return { signal: true, side: "long", stop: bar.l, target: bar.c + risk * 2 }
}
return null
`;
}

export function buildShortStrategyScript(filters: EntryFilters = DEFAULT_ENTRY_FILTERS): string {
  const f = clampFilters(filters);
  return `// MNQ 1-minute strategy. This runs in the browser on each bar.
// Inverse of the default long impulse: short a bearish impulse.
// bar: { ts, o, h, l, c, v }
// ta.sma / ta.ema(i, length, "o" | "h" | "l" | "c" | "v")
// position: null, or { side, entry, stop, target, risk } while a trade is open
// Return { signal: true, side, stop, target } to enter, { target } to tighten, or null.
// Entry fills at the signal close. One position at a time.
// Impulse entries still target 2R. A close above the 5 EMA tightens that to 1R.
// New shorts are skipped from 22:00 through 08:59 Chicago time.
// Filters: body/range >= ${f.bodyRatio}, body >= ${f.minBody}, vol > SMA(${f.volLen}) * ${f.volMult}

const ema5 = ta.ema(i, 5, "c")
if (position && position.side === "short" && bar.c > ema5) {
  return { target: position.entry - position.risk }
}

const ct = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "America/Chicago", hour: "2-digit", hourCycle: "h23" }).format(new Date(bar.ts)))
const sessionOk = ct >= 9 && ct <= 21
const avgVol = ta.sma(i, ${f.volLen}, "v")
const body = Math.abs(bar.c - bar.o)
const span = Math.max(bar.h - bar.l, 0.25)
if (!position && sessionOk && bar.c < bar.o && body / span >= ${f.bodyRatio} && body >= ${f.minBody} && bar.v > avgVol * ${f.volMult}) {
  const risk = Math.max(bar.h - bar.c, 1)
  return { signal: true, side: "short", stop: bar.h, target: bar.c - risk * 2 }
}
return null
`;
}

export const DEFAULT_STRATEGY_SCRIPT = buildLongStrategyScript(DEFAULT_ENTRY_FILTERS);
export const DEFAULT_SHORT_STRATEGY_SCRIPT = buildShortStrategyScript(DEFAULT_ENTRY_FILTERS);

export function isStaleDefaultScript(script: string) {
  return script === LEGACY_DEFAULT_STRATEGY_SCRIPT || script === EMA_EXIT_DEFAULT_STRATEGY_SCRIPT;
}

export type ScriptMarker = {
  strategyId: string;
  barIndex: number;
  visibleFromIndex: number;
  kind: "signal" | "entry" | "exit";
  win: boolean | null;
  price: number | null;
  side: "long" | "short" | null;
};

export type ScriptTrade = {
  strategyId: string;
  side: "long" | "short";
  signalIndex: number;
  entryIndex: number;
  exitIndex: number | null;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  exitPrice: number | null;
  exitReason: "stop" | "target" | null;
  riskPoints: number;
};

export type ScriptScore = {
  /** Net index points (price move), not R-multiples. */
  totalPoints: number;
  totalPnl: number;
  realizedPoints: number;
  openPoints: number;
  closedTrades: number;
  openTrades: number;
  wins: number;
  losses: number;
};

export type ScriptRun =
  | { ok: true; markers: ScriptMarker[]; trades: ScriptTrade[] }
  | { ok: false; error: string; markers: ScriptMarker[]; trades: ScriptTrade[] };

type Field = "o" | "h" | "l" | "c" | "v";

type PositionView = {
  side: "long" | "short";
  entry: number;
  stop: number;
  target: number;
  risk: number;
};

type BarFn = (
  bar: OhlcvBar,
  i: number,
  bars: OhlcvBar[],
  ta: {
    sma: (index: number, length: number, field: Field) => number;
    ema: (index: number, length: number, field: Field) => number;
  },
  position: PositionView | null,
) => unknown;

function isField(value: unknown): value is Field {
  return value === "o" || value === "h" || value === "l" || value === "c" || value === "v";
}

function isBarFn(value: unknown): value is BarFn {
  return typeof value === "function";
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readTarget(value: unknown): number | null {
  if (typeof value !== "object" || value === null) return null;
  const record = Object.fromEntries(Object.entries(value));
  if (record.signal === true) return null;
  return readNumber(record, "target");
}

function readSignal(value: unknown): {
  side: "long" | "short";
  stop: number;
  target: number;
} | null {
  if (typeof value !== "object" || value === null) return null;
  const record = Object.fromEntries(Object.entries(value));
  if (record.signal !== true) return null;
  const side = record.side === "short" ? "short" : "long";
  const stop = readNumber(record, "stop");
  const target = readNumber(record, "target");
  if (stop === null || target === null) return null;
  return { side, stop, target };
}


/** Realistic OHLC fill: gap-through at open, else level if touched. Prefer stop if both. */
function resolveExitFill(
  bar: OhlcvBar,
  side: "long" | "short",
  stop: number,
  target: number,
): { price: number; reason: "stop" | "target" } | null {
  if (side === "long") {
    if (bar.o <= stop) return { price: bar.o, reason: "stop" };
    if (bar.o >= target) return { price: bar.o, reason: "target" };
    if (bar.l <= stop) return { price: stop, reason: "stop" };
    if (bar.h >= target) return { price: target, reason: "target" };
    return null;
  }
  if (bar.o >= stop) return { price: bar.o, reason: "stop" };
  if (bar.o <= target) return { price: bar.o, reason: "target" };
  if (bar.h >= stop) return { price: stop, reason: "stop" };
  if (bar.l <= target) return { price: target, reason: "target" };
  return null;
}

function compile(source: string): BarFn {
  const created: unknown = new Function(
    "bar",
    "i",
    "bars",
    "ta",
    "position",
    `"use strict";\n${source}`,
  );
  if (!isBarFn(created)) {
    throw new Error("Script did not compile.");
  }
  return created;
}

export function runStrategyScript(bars: OhlcvBar[], source: string, strategyId = "script"): ScriptRun {
  let fn: BarFn;
  try {
    fn = compile(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Script failed to compile.";
    return { ok: false, error: message, markers: [], trades: [] };
  }

  const emaCache = new Map<string, (number | null)[]>();
  const ta = {
    sma(index: number, length: number, field: Field) {
      if (!isField(field) || length < 1) return 0;
      const start = Math.max(0, index - Math.floor(length) + 1);
      let sum = 0;
      let count = 0;
      for (let cursor = start; cursor <= index; cursor += 1) {
        sum += bars[cursor][field];
        count += 1;
      }
      return count === 0 ? 0 : sum / count;
    },
    ema(index: number, length: number, field: Field) {
      if (!isField(field) || length < 1) return 0;
      const period = Math.floor(length);
      const key = `${field}:${period}`;
      let series = emaCache.get(key);
      if (!series) {
        series = ema(
          bars.map((bar) => bar[field]),
          period,
        );
        emaCache.set(key, series);
      }
      return series[index] ?? 0;
    },
  };

  const markers: ScriptMarker[] = [];
  const trades: ScriptTrade[] = [];
  let open: ScriptTrade | null = null;

  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    if (open) {
      const stopped =
        open.side === "long" ? bar.l <= open.stopPrice : bar.h >= open.stopPrice;
      const targeted =
        open.side === "long" ? bar.h >= open.targetPrice : bar.l <= open.targetPrice;
      if (!stopped && !targeted) {
        let managed: unknown;
        try {
          managed = fn(bar, i, bars, ta, {
            side: open.side,
            entry: open.entryPrice,
            stop: open.stopPrice,
            target: open.targetPrice,
            risk: open.riskPoints,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Script threw.";
          return { ok: false, error: `Bar ${i + 1}: ${message}`, markers: [], trades: [] };
        }
        const nextTarget = readTarget(managed);
        if (nextTarget !== null) open.targetPrice = nextTarget;
      }
      const exit = resolveExitFill(bar, open.side, open.stopPrice, open.targetPrice);
      if (exit) {
        open.exitIndex = i;
        open.exitReason = exit.reason;
        open.exitPrice = exit.price;
        markers.push({
          strategyId,
          barIndex: i,
          visibleFromIndex: i,
          kind: "exit",
          win: exit.reason === "target",
          price: exit.price,
          side: open.side,
        });
        trades.push(open);
        open = null;
      }
      continue;
    }

    let result: unknown;
    try {
      result = fn(bar, i, bars, ta, null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Script threw.";
      return { ok: false, error: `Bar ${i + 1}: ${message}`, markers: [], trades: [] };
    }
    const signal = readSignal(result);
    if (!signal) continue;
    const entry = bar.c;
    const risk = Math.max(Math.abs(entry - signal.stop), 0.25);
    markers.push({
      strategyId,
      barIndex: i,
      visibleFromIndex: i,
      kind: "signal",
      win: null,
      price: null,
      side: signal.side,
    });
    markers.push({
      strategyId,
      barIndex: i,
      visibleFromIndex: i,
      kind: "entry",
      win: null,
      price: entry,
      side: signal.side,
    });
    open = {
      strategyId,
      side: signal.side,
      signalIndex: i,
      entryIndex: i,
      exitIndex: null,
      entryPrice: entry,
      stopPrice: signal.stop,
      targetPrice: signal.target,
      exitPrice: null,
      exitReason: null,
      riskPoints: risk,
    };
  }

  if (open) trades.push(open);
  return { ok: true, markers, trades };
}

export const MNQ_POINT_VALUE = 2;

/** Starting net asset for equity curves ($2 per MNQ point is added on top). */
export const STARTING_NET_ASSET = 10_000;

export type EquityPoint = {
  ts: number;
  equity: number;
};

export type BacktestStats = {
  winRate: number | null;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  maxDrawdown: number;
  averageHoldMs: number | null;
  longestHoldMs: number | null;
  shortestHoldMs: number | null;
  medianHoldMs: number | null;
  signalCount: number;
  signalIntervalMs: number | null;
  equity: EquityPoint[];
  endingEquity: number;
  /** Peak of the equity curve (includes starting capital). */
  peakEquity: number;
  /** Trough of the equity curve (includes starting capital). */
  troughEquity: number;
  startingEquity: number;
};

function isClosed(
  trade: ScriptTrade,
): trade is ScriptTrade & {
  exitIndex: number;
  exitPrice: number;
  exitReason: "stop" | "target";
} {
  return trade.exitIndex !== null && trade.exitPrice !== null && trade.exitReason !== null;
}

function tradePnl(trade: ScriptTrade, exitPrice: number) {
  const sign = trade.side === "short" ? -1 : 1;
  const points = (exitPrice - trade.entryPrice) * sign;
  return points * MNQ_POINT_VALUE;
}

export function summarizeBacktest(
  run: { markers: ScriptMarker[]; trades: ScriptTrade[] },
  bars: OhlcvBar[],
): BacktestStats {
  const closed = run.trades
    .filter(isClosed)
    .sort((left, right) => left.exitIndex - right.exitIndex || left.entryIndex - right.entryIndex);
  let winStreak = 0;
  let lossStreak = 0;
  let maxConsecutiveWins = 0;
  let maxConsecutiveLosses = 0;
  let wins = 0;
  const holds: number[] = [];
  for (const trade of closed) {
    holds.push(bars[trade.exitIndex].ts - bars[trade.entryIndex].ts);
    if (trade.exitReason === "target") {
      wins += 1;
      winStreak += 1;
      lossStreak = 0;
      if (winStreak > maxConsecutiveWins) maxConsecutiveWins = winStreak;
    } else {
      lossStreak += 1;
      winStreak = 0;
      if (lossStreak > maxConsecutiveLosses) maxConsecutiveLosses = lossStreak;
    }
  }

  const equity: EquityPoint[] = [{ ts: bars[0].ts, equity: STARTING_NET_ASSET }];
  let cursorEquity = STARTING_NET_ASSET;
  for (const trade of closed) {
    cursorEquity += tradePnl(trade, trade.exitPrice);
    equity.push({ ts: bars[trade.exitIndex].ts, equity: cursorEquity });
  }
  const open = run.trades.find((trade) => trade.exitIndex === null);
  const lastBar = bars[bars.length - 1];
  if (open) {
    cursorEquity += tradePnl(open, lastBar.c);
    equity.push({ ts: lastBar.ts, equity: cursorEquity });
  } else if (equity[equity.length - 1].ts !== lastBar.ts) {
    equity.push({ ts: lastBar.ts, equity: cursorEquity });
  }

  let peak = equity[0]?.equity ?? STARTING_NET_ASSET;
  let trough = peak;
  let maxDrawdown = 0;
  for (const point of equity) {
    if (point.equity > peak) peak = point.equity;
    if (point.equity < trough) trough = point.equity;
    const drop = peak - point.equity;
    if (drop > maxDrawdown) maxDrawdown = drop;
  }

  const spanMs = lastBar.ts - bars[0].ts;
  const signalCount = run.markers.filter((marker) => marker.kind === "signal").length;
  const sortedHolds = [...holds].sort((left, right) => left - right);
  const mid = Math.floor(sortedHolds.length / 2);
  const medianHoldMs =
    sortedHolds.length === 0
      ? null
      : sortedHolds.length % 2 === 1
        ? sortedHolds[mid]
        : (sortedHolds[mid - 1] + sortedHolds[mid]) / 2;
  const holdTotal = holds.reduce((sum, value) => sum + value, 0);

  return {
    winRate: closed.length === 0 ? null : wins / closed.length,
    maxConsecutiveWins,
    maxConsecutiveLosses,
    maxDrawdown,
    averageHoldMs: holds.length === 0 ? null : holdTotal / holds.length,
    longestHoldMs: sortedHolds.length === 0 ? null : sortedHolds[sortedHolds.length - 1],
    shortestHoldMs: sortedHolds.length === 0 ? null : sortedHolds[0],
    medianHoldMs,
    signalCount,
    signalIntervalMs: signalCount === 0 || spanMs <= 0 ? null : spanMs / signalCount,
    equity,
    endingEquity: cursorEquity,
    peakEquity: peak,
    troughEquity: trough,
    startingEquity: STARTING_NET_ASSET,
  };
}

export function scoreScript(
  trades: ScriptTrade[],
  bars: OhlcvBar[],
  cursor: number,
): ScriptScore {
  let realizedPoints = 0;
  let openPoints = 0;
  let closedTrades = 0;
  let openTrades = 0;
  let wins = 0;
  let losses = 0;
  const pointValue = MNQ_POINT_VALUE;

  for (const trade of trades) {
    if (trade.entryIndex > cursor) continue;
    const sign = trade.side === "short" ? -1 : 1;
    const marked = (price: number) => (price - trade.entryPrice) * sign;
    if (trade.exitIndex !== null && trade.exitPrice !== null && trade.exitIndex <= cursor) {
      realizedPoints += marked(trade.exitPrice);
      closedTrades += 1;
      if (trade.exitReason === "target") wins += 1;
      if (trade.exitReason === "stop") losses += 1;
    } else {
      openPoints += marked(bars[cursor].c);
      openTrades += 1;
    }
  }

  const totalPoints = realizedPoints + openPoints;
  return {
    totalPoints,
    totalPnl: totalPoints * pointValue,
    realizedPoints,
    openPoints,
    closedTrades,
    openTrades,
    wins,
    losses,
  };
}

export type NamedScriptRun = {
  id: string;
  name: string;
  color: string;
  run: ScriptRun;
};

export type EquitySeries = {
  id: string;
  name: string;
  color: string;
  equity: EquityPoint[];
  endingEquity: number;
  peakEquity: number;
  troughEquity: number;
};

export type MultiBacktestReport = {
  series: EquitySeries[];
  /** Primary stats: combined when multiple series, else the single series. */
  stats: BacktestStats;
  perStrategy: { id: string; name: string; color: string; stats: BacktestStats }[];
};

export const STRATEGY_COLORS = {
  long: "#3dd68c",
  short: "#7aa2ff",
  combined: "#f0c14a",
} as const;

export function mergeScriptRuns(named: NamedScriptRun[]): ScriptRun {
  const okRuns = named.filter((item) => item.run.ok);
  if (okRuns.length === 0) {
    const first = named[0]?.run;
    return first ?? { ok: false, error: "No strategies enabled.", markers: [], trades: [] };
  }
  const failed = named.find((item) => !item.run.ok);
  if (failed && !failed.run.ok) {
    return {
      ok: false,
      error: `${failed.name}: ${failed.run.error}`,
      markers: [],
      trades: [],
    };
  }
  const markers = okRuns.flatMap((item) => item.run.markers);
  const trades = okRuns.flatMap((item) => item.run.trades);
  return { ok: true, markers, trades };
}

export function summarizeMultiBacktest(
  named: NamedScriptRun[],
  bars: OhlcvBar[],
): MultiBacktestReport | null {
  const okNamed = named.filter((item) => item.run.ok);
  if (okNamed.length === 0 || bars.length === 0) return null;

  const perStrategy = okNamed.map((item) => ({
    id: item.id,
    name: item.name,
    color: item.color,
    stats: summarizeBacktest(item.run, bars),
  }));

  const series: EquitySeries[] = perStrategy.map((item) => ({
    id: item.id,
    name: item.name,
    color: item.color,
    equity: item.stats.equity,
    endingEquity: item.stats.endingEquity,
    peakEquity: item.stats.peakEquity,
    troughEquity: item.stats.troughEquity,
  }));

  const merged = mergeScriptRuns(okNamed);
  const combinedStats = summarizeBacktest(merged, bars);
  if (okNamed.length > 1) {
    series.push({
      id: "combined",
      name: "Combined",
      color: STRATEGY_COLORS.combined,
      equity: combinedStats.equity,
      endingEquity: combinedStats.endingEquity,
      peakEquity: combinedStats.peakEquity,
      troughEquity: combinedStats.troughEquity,
    });
  }

  return {
    series,
    stats: combinedStats,
    perStrategy,
  };
}
