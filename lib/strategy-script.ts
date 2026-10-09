import { ema } from "@/lib/ema";
import type { OhlcvBar } from "@/lib/strategies/types";

export const STRATEGY_STORAGE_KEY = "mnq-replay.strategyScript";

/** Previous on-page default, so a saved copy of it upgrades to the EMA exit. */
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

export const DEFAULT_STRATEGY_SCRIPT = `// MNQ 1-minute strategy. This runs in the browser on each bar.
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

export type ScriptMarker = {
  barIndex: number;
  visibleFromIndex: number;
  kind: "signal" | "entry" | "exit";
  win: boolean | null;
  price: number | null;
  side: "long" | "short" | null;
};

export type ScriptTrade = {
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
  totalR: number;
  totalPnl: number;
  realizedR: number;
  openR: number;
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

export function runStrategyScript(bars: OhlcvBar[], source: string): ScriptRun {
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
      const hitStop =
        open.side === "long" ? bar.l <= open.stopPrice : bar.h >= open.stopPrice;
      const hitTarget =
        open.side === "long" ? bar.h >= open.targetPrice : bar.l <= open.targetPrice;
      if (hitStop || hitTarget) {
        const reason = hitStop ? "stop" : "target";
        const price = reason === "stop" ? open.stopPrice : open.targetPrice;
        open.exitIndex = i;
        open.exitReason = reason;
        open.exitPrice = price;
        markers.push({
          barIndex: i,
          visibleFromIndex: i,
          kind: "exit",
          win: reason === "target",
          price,
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
      barIndex: i,
      visibleFromIndex: i,
      kind: "signal",
      win: null,
      price: null,
      side: signal.side,
    });
    markers.push({
      barIndex: i,
      visibleFromIndex: i,
      kind: "entry",
      win: null,
      price: entry,
      side: signal.side,
    });
    open = {
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
  const risk = trade.riskPoints === 0 ? 0.25 : trade.riskPoints;
  return (((exitPrice - trade.entryPrice) * sign) / risk) * MNQ_POINT_VALUE;
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

  const equity: EquityPoint[] = [{ ts: bars[0].ts, equity: 0 }];
  let cursorEquity = 0;
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

  let peak = 0;
  let maxDrawdown = 0;
  for (const point of equity) {
    if (point.equity > peak) peak = point.equity;
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
  };
}

export function scoreScript(
  trades: ScriptTrade[],
  bars: OhlcvBar[],
  cursor: number,
): ScriptScore {
  let realizedR = 0;
  let openR = 0;
  let closedTrades = 0;
  let openTrades = 0;
  let wins = 0;
  let losses = 0;
  const pointValue = MNQ_POINT_VALUE;

  for (const trade of trades) {
    if (trade.entryIndex > cursor) continue;
    const sign = trade.side === "short" ? -1 : 1;
    const marked = (price: number) => ((price - trade.entryPrice) * sign) / trade.riskPoints;
    if (trade.exitIndex !== null && trade.exitPrice !== null && trade.exitIndex <= cursor) {
      realizedR += marked(trade.exitPrice);
      closedTrades += 1;
      if (trade.exitReason === "target") wins += 1;
      if (trade.exitReason === "stop") losses += 1;
    } else {
      openR += marked(bars[cursor].c);
      openTrades += 1;
    }
  }

  const totalR = realizedR + openR;
  return {
    totalR,
    totalPnl: totalR * pointValue,
    realizedR,
    openR,
    closedTrades,
    openTrades,
    wins,
    losses,
  };
}
